"""Read selected Notion pages without following remote links or persisting raw data."""

from datetime import datetime
import re
from uuid import UUID

from .remote_sources import RemoteError, digest


MAX_PAGES = 100
MAX_BLOCKS = 10_000
MAX_DEPTH = 64
MAX_LIST_RESPONSES = 1_000
_UUID = re.compile(r'(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\Z')
_TEXT_BLOCKS = frozenset({
    'paragraph', 'heading_1', 'heading_2', 'heading_3', 'heading_4',
    'bulleted_list_item', 'numbered_list_item', 'quote', 'to_do', 'toggle',
    'template', 'code', 'callout',
})
_CONTAINERS = frozenset({'column_list', 'column', 'table', 'synced_block'})
_EMPTY_BLOCKS = frozenset({'divider', 'breadcrumb', 'table_of_contents'})
_ATTACHMENTS = frozenset({'image', 'video', 'pdf', 'file', 'audio', 'embed', 'bookmark', 'link_preview'})
_KNOWN_BLOCKS = (_TEXT_BLOCKS | _CONTAINERS | _EMPTY_BLOCKS | _ATTACHMENTS
                 | {'equation', 'table_row', 'child_page', 'child_database', 'link_to_page'})


def _id(value):
    if not isinstance(value, str) or not _UUID.fullmatch(value):
        raise RemoteError('notion-invalid-record-id')
    return str(UUID(value))


def validate_selection(selection: dict) -> dict:
    """Reject implicit scope and return a fresh canonical selection."""
    if not isinstance(selection, dict) or set(selection) != {'page_ids'}:
        raise RemoteError('notion-explicit-page-selection-required')
    values = selection['page_ids']
    if not isinstance(values, list) or not 1 <= len(values) <= MAX_PAGES:
        raise RemoteError('notion-invalid-page-selection-size')
    ids = [_id(value) for value in values]
    if len(set(ids)) != len(ids):
        raise RemoteError('notion-duplicate-page-selection')
    return {'page_ids': sorted(ids)}


def _normalize(text):
    return text.replace('\r\n', '\n').replace('\r', '\n').replace('\x00', '')


def _annotations(item, plain, gaps, location):
    annotations = item.get('annotations', {})
    flags = {'strikethrough', 'bold', 'italic', 'underline', 'code'}
    if (not isinstance(annotations, dict)
            or any(key in annotations and not isinstance(annotations[key], bool) for key in flags)
            or ('color' in annotations and not isinstance(annotations['color'], str))):
        raise RemoteError('notion-invalid-rich-text-annotations')
    if any(annotations.get(key) for key in flags - {'strikethrough'}) or annotations.get('color', 'default') != 'default':
        gaps.append('rich-text-annotation-formatting-not-preserved:' + location)
    if set(annotations) - flags - {'color'}:
        gaps.append('rich-text-unknown-annotation-semantics:' + location)
    if annotations.get('strikethrough'):
        # Added markers are part of normalized citation text, not raw API offsets.
        gaps.append('rich-text-strikethrough-converted-to-markdown:' + location)
        if '~~' in plain or '\n' in plain or plain != plain.strip():
            gaps.append('rich-text-strikethrough-rendering-unverified:' + location)
        return '~~' + plain + '~~'
    return plain


def _rich(value, gaps, location):
    if not isinstance(value, list):
        gaps.append('rich-text-unavailable:' + location)
        return ''
    text = []
    for item in value:
        if not isinstance(item, dict):
            gaps.append('rich-text-item-unavailable:' + location)
            continue
        if item.get('type') == 'mention' or 'mention' in item:
            gaps.append('rich-text-mention-reference-not-followed:' + location)
        content = item.get('text')
        if (item.get('href') is not None
                or isinstance(content, dict) and content.get('link') is not None):
            gaps.append('rich-text-link-target-omitted:' + location)
        if item.get('type') not in ('text', 'mention', 'equation'):
            gaps.append('rich-text-item-semantics-unverified:' + location)
        plain = item.get('plain_text')
        if not isinstance(plain, str):
            plain = content.get('content') if isinstance(content, dict) else None
        if isinstance(plain, str):
            text.append(_annotations(item, _normalize(plain), gaps, location))
        else:
            gaps.append('rich-text-item-unavailable:' + location)
    return ''.join(text)


def _page(value, page_id):
    if not isinstance(value, dict) or value.get('object') != 'page':
        raise RemoteError('notion-invalid-page-response')
    if _id(value.get('id')) != page_id:
        raise RemoteError('notion-page-identity-mismatch')
    for key in ('archived', 'in_trash'):
        if key in value and not isinstance(value[key], bool):
            raise RemoteError('notion-invalid-page-state')
        if value.get(key):
            raise RemoteError('notion-page-archived-or-trashed')
    return value


def _timestamp(value):
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 64 or 'T' not in value:
        raise RemoteError('notion-invalid-updated-at')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise RemoteError('notion-invalid-updated-at') from None
    if parsed.tzinfo is None:
        raise RemoteError('notion-invalid-updated-at')
    return value


def _title(page, gaps):
    props = page.get('properties')
    titles = []
    if isinstance(props, dict):
        for prop in props.values():
            if not isinstance(prop, dict) or prop.get('type') != 'title':
                gaps.append('non-title-page-properties-not-extracted')
                continue
            value = prop.get('title')
            titles.append(_rich(value, gaps, 'page-title'))
            if isinstance(value, list) and any(isinstance(item, dict) and item.get('type') == 'mention' for item in value):
                gaps.append('page-title-mention-reference-coverage-unverified')
    if len(titles) > 1:
        raise RemoteError('notion-ambiguous-page-title')
    title = titles[0] if titles else ''
    if not title:
        gaps.append('page-title-unavailable')
        title = 'Untitled Notion page'
    if page.get('icon') is not None or page.get('cover') is not None:
        gaps.append('page-icon-or-cover-not-fetched')
    return title


def _block_text(block, kind, block_id, gaps):
    """Return normalized text and whether contained descendants may be visited."""
    content = block.get(kind)
    if not isinstance(content, dict):
        gaps.append('block-content-unavailable:' + block_id)
        return '', False
    if kind in _TEXT_BLOCKS:
        text = _rich(content.get('rich_text'), gaps, block_id)
        if kind == 'to_do':
            checked = content.get('checked')
            if not isinstance(checked, bool):
                gaps.append('task-checked-state-unavailable:' + block_id)
            else:
                text = ('[x] ' if checked else '[ ] ') + text
        if 'caption' in content:
            text += '\n' + _rich(content['caption'], gaps, block_id)
        return text, True
    if kind == 'equation':
        expression = content.get('expression')
        if not isinstance(expression, str):
            gaps.append('equation-content-unavailable:' + block_id)
            return '', False
        return _normalize(expression), False
    if kind == 'table_row':
        cells = content.get('cells')
        if not isinstance(cells, list):
            gaps.append('table-row-content-unavailable:' + block_id)
            return '', False
        return ' | '.join(_rich(cell, gaps, block_id) for cell in cells), False
    if kind in _CONTAINERS:
        if kind == 'synced_block' and 'synced_from' not in content:
            gaps.append('synced-origin-unavailable:' + block_id)
            return '', False
        if kind == 'synced_block' and content.get('synced_from') is not None:
            gaps.append('synced-reference-not-followed:' + block_id)
            return '', False
        return '', True
    if kind in _EMPTY_BLOCKS:
        return '', False
    if kind in ('child_page', 'child_database'):
        gaps.append(('child-page-not-followed:' if kind == 'child_page' else 'child-database-not-followed:') + block_id)
        title = content.get('title')
        if not isinstance(title, str):
            gaps.append('child-title-unavailable:' + block_id)
        return _normalize(title) if isinstance(title, str) else '', False
    if kind == 'link_to_page':
        gaps.append('linked-page-not-followed:' + block_id)
        return '', False
    if kind in _ATTACHMENTS:
        gaps.append('attachment-content-and-url-omitted:' + block_id)
        parts = []
        if isinstance(content.get('name'), str):
            parts.append(_normalize(content['name']))
        if 'caption' in content:
            parts.append(_rich(content['caption'], gaps, block_id))
        return '\n'.join(parts), False
    gaps.append('unsupported-block-content:' + block_id)
    return '', False


def fetch(client, source) -> list[dict]:
    """Collect a response set in memory; any failure prevents partial publication."""
    selection = validate_selection(source.get('selection') if isinstance(source, dict) else None)
    documents = []
    source_blocks = set()
    for page_id in selection['page_ids']:
        page = _page(client.get('/pages/' + page_id), page_id)
        raw = [page]
        gaps = ['comments-not-fetched']
        title = _title(page, gaps)
        updated_at = _timestamp(page.get('last_edited_time'))
        if updated_at is None:
            gaps.append('page-updated-at-unavailable')
        lines = [title]
        seen = {page_id}
        list_responses = 0

        def children(parent_id, depth):
            nonlocal list_responses
            if depth > MAX_DEPTH:
                raise RemoteError('notion-block-depth-limit')
            cursor = None
            cursors = set()
            while True:
                if list_responses >= MAX_LIST_RESPONSES:
                    raise RemoteError('notion-list-response-limit')
                list_responses += 1
                params = {'page_size': 100}
                if cursor is not None:
                    params['start_cursor'] = cursor
                response = client.get('/blocks/' + parent_id + '/children', params)
                if (not isinstance(response, dict) or response.get('object') != 'list'
                        or not isinstance(response.get('results'), list)
                        or not isinstance(response.get('has_more'), bool)
                        or 'next_cursor' not in response
                        or response.get('type', 'block') != 'block'):
                    raise RemoteError('notion-invalid-pagination-response')
                rows = response['results']
                if len(rows) > 100:
                    raise RemoteError('notion-invalid-pagination-size')
                next_cursor = response['next_cursor']
                if response['has_more']:
                    if not isinstance(next_cursor, str) or not next_cursor or next_cursor in cursors:
                        raise RemoteError('notion-invalid-pagination-cursor')
                    cursors.add(next_cursor)
                elif next_cursor is not None:
                    raise RemoteError('notion-invalid-pagination-cursor')
                raw.append(response)
                for block in rows:
                    if not isinstance(block, dict) or block.get('object') != 'block':
                        raise RemoteError('notion-invalid-block-response')
                    block_id = _id(block.get('id'))
                    if block_id in seen or block_id in source_blocks:
                        raise RemoteError('notion-duplicate-block-id')
                    if len(seen) > MAX_BLOCKS:
                        raise RemoteError('notion-block-count-limit')
                    seen.add(block_id)
                    source_blocks.add(block_id)
                    parent = block.get('parent')
                    if parent is None:
                        gaps.append('block-parent-unavailable:' + block_id)
                    elif (not isinstance(parent, dict)
                          or parent.get('type') != ('page_id' if parent_id == page_id else 'block_id')
                          or _id(parent.get(parent['type'])) != parent_id):
                        raise RemoteError('notion-block-parent-mismatch')
                    has_children = block.get('has_children')
                    kind = block.get('type')
                    if not isinstance(has_children, bool) or not isinstance(kind, str):
                        raise RemoteError('notion-invalid-block-shape')
                    text, descend = _block_text(block, kind, block_id, gaps)
                    known_kind = kind if kind in _KNOWN_BLOCKS else 'unsupported'
                    lines.append('  ' * depth + '[block:' + block_id + ' type:' + known_kind + ']')
                    if text:
                        lines.append(text)
                    if has_children and descend:
                        client.allow_block(block_id)
                        children(block_id, depth + 1)
                    elif has_children:
                        gaps.append('block-descendants-not-fetched:' + block_id)
                if not response['has_more']:
                    break
                cursor = next_cursor

        children(page_id, 0)
        rechecked = _page(client.get('/pages/' + page_id), page_id)
        raw.append(rechecked)
        if _timestamp(rechecked.get('last_edited_time')) != updated_at:
            raise RemoteError('notion-page-changed-during-fetch')
        documents.append({
            'path': 'pages/' + page_id, 'object_id': page_id,
            'url': 'https://app.notion.com/p/' + page_id,
            'title': title, 'text': '\n'.join(lines), 'updated_at': updated_at,
            'gaps': sorted(set(gaps)), 'raw_content_sha256': digest(raw),
        })
    return documents
