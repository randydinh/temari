"""Extract selected full Shortcut stories through the shared GET-only client.

Source strings are evidence, never executable instructions. This module neither
follows source URLs nor persists responses; the registry owns publication.
"""
from __future__ import annotations

from datetime import datetime
import re
from urllib.parse import unquote, urlsplit, urlunsplit

from knowledge_agent.remote_sources import RemoteError, digest

MAX_STORIES = 100
_STORY_PATH = re.compile(r'/[A-Za-z0-9_-]+/story/([1-9][0-9]*)(?:/[^/\s?#\\]*)?')
_DATE = re.compile(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})')


def _positive(value):
    if type(value) is not int or value <= 0:
        raise RemoteError('invalid-shortcut-id')
    return value


def validate_selection(selection: dict) -> dict:
    if not isinstance(selection, dict) or set(selection) != {'story_ids'}:
        raise ValueError('shortcut-selection-requires-story-ids')
    ids = selection['story_ids']
    if not isinstance(ids, list) or not 1 <= len(ids) <= MAX_STORIES:
        raise ValueError('shortcut-selection-size-invalid')
    for sid in ids:
        if type(sid) is not int or sid <= 0:
            raise ValueError('shortcut-story-ids-must-be-positive-integers')
    if len(set(ids)) != len(ids):
        raise ValueError('duplicate-shortcut-story-id')
    return {'story_ids': sorted(ids)}


def _text(value):
    if not isinstance(value, str):
        raise RemoteError('invalid-shortcut-text')
    return value.replace('\r\n', '\n').replace('\r', '\n')


def _date(value):
    if value is None:
        return None
    if not isinstance(value, str) or not _DATE.fullmatch(value):
        raise RemoteError('invalid-shortcut-timestamp')
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise RemoteError('invalid-shortcut-timestamp') from None
    if parsed.tzinfo is None:
        raise RemoteError('invalid-shortcut-timestamp')
    return value


def _url(value, sid):
    if not isinstance(value, str) or any(c.isspace() or ord(c) < 32 for c in value) or '\\' in value:
        raise RemoteError('invalid-shortcut-story-url')
    try:
        parsed = urlsplit(value)
        decoded_path = unquote(parsed.path)
        path = _STORY_PATH.fullmatch(decoded_path)
        if (parsed.scheme != 'https' or parsed.hostname != 'app.shortcut.com' or
                parsed.username is not None or parsed.password is not None or
                parsed.port is not None or not path or int(path.group(1)) != sid or
                any(part in ('.', '..') for part in decoded_path.split('/')) or
                '%' in decoded_path or any(ord(c) < 32 for c in decoded_path)):
            raise ValueError()
    except ValueError:
        raise RemoteError('invalid-shortcut-story-url') from None
    return urlunsplit(('https', 'app.shortcut.com', parsed.path, '', ''))


def _not_partial(row):
    # Full Story is not a paginated envelope. Never silently consume a future
    # provider/adapter response that explicitly advertises omitted content.
    for key in ('has_more', 'truncated'):
        if row.get(key) is not None and row[key] is not False:
            raise RemoteError('incomplete-shortcut-response')
    for key in ('next', 'next_page', 'next_cursor'):
        if row.get(key) is not None:
            raise RemoteError('incomplete-shortcut-response')


def _objects(story, field, sid, *, belongs=False):
    rows = story.get(field)
    if not isinstance(rows, list):
        raise RemoteError('missing-or-invalid-shortcut-collection')
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise RemoteError('invalid-shortcut-object')
        _not_partial(row)
        oid = _positive(row.get('id'))
        if oid in seen:
            raise RemoteError('duplicate-shortcut-object-id')
        seen.add(oid)
        if belongs and _positive(row.get('story_id')) != sid:
            raise RemoteError('shortcut-object-outside-selected-story')
    slim_field = {'comments': 'comment_ids', 'tasks': 'task_ids',
                  'files': 'file_ids', 'linked_files': 'linked_file_ids'}[field]
    if slim_field in story:
        ids = story[slim_field]
        if not isinstance(ids, list):
            raise RemoteError('invalid-shortcut-object-ids')
        ids = [_positive(i) for i in ids]
        if len(ids) != len(set(ids)) or set(ids) != seen:
            raise RemoteError('incomplete-shortcut-response')
    return rows


def _comment_lines(rows, gaps):
    parents = {}
    for row in rows:
        parent = row.get('parent_id')
        parents[row['id']] = _positive(parent) if parent is not None else None
    resolved = set()
    for cid in parents:
        seen = set()
        current = cid
        while current is not None and current not in resolved:
            if current in seen or current not in parents:
                raise RemoteError('incomplete-or-cyclic-shortcut-comment-thread')
            seen.add(current)
            current = parents[current]
        resolved.update(seen)
    lines = []
    for row in rows:
        cid = row['id']
        if type(row.get('deleted')) is not bool:
            raise RemoteError('invalid-shortcut-comment-state')
        lines.extend([f'## Comment {cid}', f'deleted: {str(row["deleted"]).lower()}'])
        if parents[cid] is not None:
            lines.append(f'parent_id: {parents[cid]}')
        if row.get('author_id') is not None:
            lines.append('author_id: ' + _text(row['author_id']))
        for key in ('created_at', 'updated_at'):
            value = _date(row.get(key))
            if value is not None:
                lines.append(f'{key}: {value}')
        body = row.get('text')
        if body is None and row['deleted']:
            if 'comment-text-unavailable' not in gaps:
                gaps.append('comment-text-unavailable')
            lines.append('[Comment text unavailable]')
        else:
            lines.append(_text(body))
    return lines


def _task_lines(rows):
    lines = []
    for row in rows:
        if type(row.get('complete')) is not bool:
            raise RemoteError('invalid-shortcut-task-state')
        lines.extend([f'## Task {row["id"]}', f'complete: {str(row["complete"]).lower()}',
                      _text(row.get('description'))])
        for key in ('created_at', 'updated_at', 'completed_at'):
            value = _date(row.get(key))
            if value is not None:
                lines.append(f'{key}: {value}')
    return lines


def _attachment_lines(rows, sid, label):
    lines = []
    for row in rows:
        if 'story_ids' in row:
            ids = row['story_ids']
            if not isinstance(ids, list):
                raise RemoteError('invalid-shortcut-attachment-scope')
            ids = [_positive(i) for i in ids]
            if sid not in ids or len(ids) != len(set(ids)):
                raise RemoteError('shortcut-attachment-outside-selected-story')
        lines.append(f'## {label} {row["id"]} (metadata only)')
        for key in ('name', 'filename', 'description', 'content_type', 'type'):
            if row.get(key) is not None:
                lines.append(f'{key}: ' + _text(row[key]))
        if row.get('size') is not None:
            if type(row['size']) is not int or row['size'] < 0:
                raise RemoteError('invalid-shortcut-attachment-size')
            lines.append(f'size: {row["size"]}')
    return lines


def _document(row, sid):
    if not isinstance(row, dict):
        raise RemoteError('invalid-shortcut-story')
    _not_partial(row)
    if _positive(row.get('id')) != sid:
        raise RemoteError('shortcut-story-id-mismatch')
    title = _text(row.get('name'))
    if not title.strip():
        raise RemoteError('missing-shortcut-title')
    url = _url(row.get('app_url'), sid)
    updated = _date(row.get('updated_at'))
    comments = _objects(row, 'comments', sid, belongs=True)
    tasks = _objects(row, 'tasks', sid, belongs=True)
    files = _objects(row, 'files', sid)
    linked = _objects(row, 'linked_files', sid)
    gaps = ['relationships-not-expanded', 'history-not-fetched',
            'unmapped-story-metadata-not-indexed', 'upstream-visibility-not-verifiable']
    if files or linked:
        gaps.append('attachments-not-downloaded')
    lines = [f'# {title}', '## Description', _text(row.get('description'))]
    lines.extend(_comment_lines(comments, gaps))
    lines.extend(_task_lines(tasks))
    lines.extend(_attachment_lines(files, sid, 'Attachment'))
    lines.extend(_attachment_lines(linked, sid, 'Linked attachment'))
    return {'path': f'stories/{sid}', 'object_id': str(sid), 'url': url,
            'title': title, 'text': '\n\n'.join(lines), 'updated_at': updated,
            'gaps': gaps, 'raw_content_sha256': digest(row)}


def fetch(client, source) -> list[dict]:
    selection = validate_selection(source.get('selection'))
    return [_document(client.get(f'/stories/{sid}'), sid)
            for sid in selection['story_ids']]
