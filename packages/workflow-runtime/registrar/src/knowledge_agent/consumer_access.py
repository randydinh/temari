"""Connection-scoped evidence access over the shared source registry."""
from __future__ import annotations

from collections.abc import Mapping, Sequence
import copy
from dataclasses import dataclass
from pathlib import Path
import sqlite3
from typing import Any


ALLOWLIST_ERROR = 'consumer source allowlist is invalid'
SCOPE_ERROR = 'requested evidence is outside this connection scope'
RESPONSE_ERROR = 'consumer response could not be safely returned'
OPAQUE = {'access': 'outside-connection-source-scope'}

MAX_SOURCE_IDS = 100
MAX_SOURCE_ID_LENGTH = 80
MAX_TRAVERSAL_DEPTH = 32
MAX_TRAVERSAL_NODES = 10_000
MAX_TRAVERSAL_LIST = 1_000
MAX_TRAVERSAL_STRING = 65_536
MAX_RESPONSE_DEPTH = 64
MAX_RESPONSE_NODES = 100_000
MAX_RESPONSE_LIST = 10_000
MAX_RESPONSE_STRING = 1_048_576


class _UnsafeResponse(Exception):
    pass


def _valid_source_id(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= MAX_SOURCE_ID_LENGTH


def _source_id_sequence(values: Any) -> tuple[str, ...] | None:
    if (not isinstance(values, (list, tuple)) or not 1 <= len(values) <= MAX_SOURCE_IDS
            or any(not _valid_source_id(value) for value in values)):
        return None
    normalized = tuple(values)
    if len(set(normalized)) != len(normalized):
        return None
    return normalized


@dataclass(frozen=True)
class ConsumerScope:
    source_ids: tuple[str, ...]

    def __post_init__(self):
        normalized = _source_id_sequence(self.source_ids)
        if normalized is None or tuple(sorted(normalized)) != self.source_ids:
            raise ValueError(ALLOWLIST_ERROR)

    @classmethod
    def create(cls, source_ids: Sequence[str]) -> ConsumerScope:
        normalized = _source_id_sequence(source_ids)
        if normalized is None:
            raise ValueError(ALLOWLIST_ERROR)
        return cls(tuple(sorted(normalized)))

    def normalize(self, requested: Sequence[str] | None) -> tuple[str, ...]:
        if requested is None:
            return self.source_ids
        normalized = _source_id_sequence(requested)
        if normalized is None or not set(normalized).issubset(self.source_ids):
            raise ValueError(SCOPE_ERROR)
        return normalized


def _bounded_walk(
        value: Any,
        error: str,
        *,
        max_depth: int = MAX_TRAVERSAL_DEPTH,
        max_nodes: int = MAX_TRAVERSAL_NODES,
        max_list: int = MAX_TRAVERSAL_LIST,
        max_string: int = MAX_TRAVERSAL_STRING,
):
    pending = [(value, 0, None)]
    visited = 0
    while pending:
        current, depth, field = pending.pop()
        visited += 1
        if visited > max_nodes or depth > max_depth:
            raise ValueError(error)
        if isinstance(current, str):
            if len(current) > max_string:
                raise ValueError(error)
            yield current, field
            continue
        if isinstance(current, Mapping):
            if len(current) > max_list:
                raise ValueError(error)
            yield current, field
            for key, child in current.items():
                if not isinstance(key, str) or len(key) > max_string:
                    raise ValueError(error)
                pending.append((child, depth + 1, key))
            continue
        if isinstance(current, (list, tuple)):
            if len(current) > max_list:
                raise ValueError(error)
            yield current, field
            pending.extend((child, depth + 1, None) for child in reversed(current))
            continue
        if current is not None and not isinstance(current, (bool, int, float)):
            raise ValueError(error)
        yield current, field


def _authorize_request(value: Any, allowed: frozenset[str]) -> None:
    for current, field in _bounded_walk(value, SCOPE_ERROR):
        if field == 'snapshot_generations' and current is not None:
            if not isinstance(current, Mapping) or not current or not set(current).issubset(allowed):
                raise ValueError(SCOPE_ERROR)
        if field == 'source_id':
            if not _valid_source_id(current) or current not in allowed:
                raise ValueError(SCOPE_ERROR)
        elif field == 'source_ids':
            normalized = _source_id_sequence(current)
            if normalized is None or not set(normalized).issubset(allowed):
                raise ValueError(SCOPE_ERROR)


def _source_metadata(rows: list[dict], allowed: frozenset[str]):
    allowed_rows = [row for row in rows if row.get('id') in allowed]
    denied_rows = [row for row in rows if row.get('id') not in allowed]
    allowed_labels = {row.get('label') for row in allowed_rows if isinstance(row.get('label'), str)}
    allowed_roots = {row.get('root') for row in allowed_rows if isinstance(row.get('root'), str)}
    denied_labels = {
        row.get('label') for row in denied_rows
        if isinstance(row.get('label'), str) and row.get('label')
        and row.get('label') not in allowed_labels
    }
    denied_roots = {
        row.get('root') for row in denied_rows
        if isinstance(row.get('root'), str) and row.get('root')
        and row.get('root') not in allowed_roots
    }
    return allowed_rows, denied_labels, denied_roots


def _public_label(row: dict) -> str:
    label = row['label']
    private_values = {
        row[key] for key in ('root', 'supplied_path')
        if isinstance(row.get(key), str)
    }
    absolute_paths = {value for value in private_values if Path(value).is_absolute()}
    if (label in private_values or Path(label).is_absolute()
            or any(path in label for path in absolute_paths)):
        return 'Registered source'
    return label


def _source_neutral_gap(value: Mapping) -> bool:
    return (set(value) <= {'source_id', 'reason', 'count'}
            and value.get('source_id') == ''
            and isinstance(value.get('reason'), str)
            and bool(value['reason'])
            and type(value.get('count')) is int
            and value['count'] >= 1)


def _is_source_row(value: Mapping) -> bool:
    status_row = {'id', 'label', 'enabled', 'scan_status'}.issubset(value)
    retrieval_row = {'id', 'generation', 'enabled', 'scan_status', 'inventory'}.issubset(value)
    return status_row or retrieval_row


def _sanitize(value: Any, allowed: frozenset[str]):
    if isinstance(value, Mapping):
        if 'snapshot_generations' in value:
            mapping = value['snapshot_generations']
            if not isinstance(mapping, Mapping) or not set(mapping).issubset(allowed):
                raise _UnsafeResponse()
        if 'source_id' in value:
            direct_id = value['source_id']
            if direct_id == '':
                if not _source_neutral_gap(value):
                    raise _UnsafeResponse
            elif not _valid_source_id(direct_id):
                raise _UnsafeResponse
            elif direct_id not in allowed:
                return dict(OPAQUE)
        sanitized = {}
        for key, child in value.items():
            if key == 'absolute_path':
                continue
            sanitized[key] = _sanitize(child, allowed)
        return sanitized
    if isinstance(value, (list, tuple)):
        return [_sanitize(child, allowed) for child in value]
    return copy.deepcopy(value)


def _contains_denied_path(value: str, roots: set[str]) -> bool:
    path = Path(value)
    return any(path == Path(root) or Path(root) in path.parents for root in roots)


def _check_postcondition(
        payload: Any,
        allowed: frozenset[str],
        denied_labels: set[str],
        denied_roots: set[str],
) -> None:
    for current, field in _bounded_walk(
            payload,
            RESPONSE_ERROR,
            max_depth=MAX_RESPONSE_DEPTH,
            max_nodes=MAX_RESPONSE_NODES,
            max_list=MAX_RESPONSE_LIST,
            max_string=MAX_RESPONSE_STRING,
    ):
        if field == 'absolute_path':
            raise _UnsafeResponse
        if field == 'source_ids':
            normalized = _source_id_sequence(current)
            if normalized is None or not set(normalized).issubset(allowed):
                raise _UnsafeResponse
        if isinstance(current, Mapping):
            if 'source_id' in current:
                source_id = current['source_id']
                if not _source_neutral_gap(current) and (
                        not _valid_source_id(source_id) or source_id not in allowed):
                    raise _UnsafeResponse
            if _is_source_row(current):
                source_row_id = current.get('id')
                if not _valid_source_id(source_row_id) or source_row_id not in allowed:
                    raise _UnsafeResponse
        elif isinstance(current, str):
            if field in ('label', 'source_label') and current in denied_labels:
                raise _UnsafeResponse
            if field in ('root', 'source_root', 'supplied_path', 'path') and _contains_denied_path(
                    current, denied_roots):
                raise _UnsafeResponse


def _sanitize_result(payload: Any, rows: list[dict], allowed: frozenset[str]) -> dict:
    try:
        _, denied_labels, denied_roots = _source_metadata(rows, allowed)
        for _ in _bounded_walk(
                payload,
                RESPONSE_ERROR,
                max_depth=MAX_RESPONSE_DEPTH,
                max_nodes=MAX_RESPONSE_NODES,
                max_list=MAX_RESPONSE_LIST,
                max_string=MAX_RESPONSE_STRING,
        ):
            pass
        sanitized = _sanitize(payload, allowed)
        if not isinstance(sanitized, dict):
            raise _UnsafeResponse
        _check_postcondition(sanitized, allowed, denied_labels, denied_roots)
        return sanitized
    except (_UnsafeResponse, ValueError, TypeError):
        raise ValueError(RESPONSE_ERROR) from None


@dataclass(frozen=True)
class ConsumerGateway:
    registry: Any
    scope: ConsumerScope

    def __post_init__(self):
        try:
            registered = {row['id'] for row in self.registry.list()}
        except (KeyError, TypeError, ValueError, OSError, sqlite3.Error):
            raise ValueError(ALLOWLIST_ERROR) from None
        if not set(self.scope.source_ids).issubset(registered):
            raise ValueError(ALLOWLIST_ERROR)

    @property
    def _allowed(self) -> frozenset[str]:
        return frozenset(self.scope.source_ids)

    def _result(self, payload: Any) -> dict:
        try:
            rows = self.registry.list()
        except (TypeError, ValueError, OSError, sqlite3.Error):
            raise ValueError(RESPONSE_ERROR) from None
        return _sanitize_result(payload, rows, self._allowed)

    def _dispatch(self, operation, *args, **kwargs) -> dict:
        try:
            payload = operation(*args, **kwargs)
        except (ValueError, OSError, sqlite3.Error):
            raise ValueError(RESPONSE_ERROR) from None
        return self._result(payload)

    def status(self) -> dict:
        try:
            rows = self.registry.list()
            allowed_rows, _, _ = _source_metadata(rows, self._allowed)
            by_id = {row['id']: row for row in allowed_rows}
            selected = [by_id[source_id] for source_id in self.scope.source_ids]
            payload = {
                'schema': 1,
                'profile': 'source-read-only',
                'source_count': len(selected),
                'enabled_sources': sum(row['enabled'] is True for row in selected),
                'sources': [{
                    'id': row['id'],
                    'label': _public_label(row),
                    'enabled': row['enabled'],
                    'scan_status': row['scan_status'],
                    'last_scan_at': row['last_scan_at'],
                    'counts': copy.deepcopy(row['counts']),
                } for row in selected],
                'discovery': 'last successful scan; refresh requires an operator connection',
                'modes': {
                    'exact': 'available',
                    'semantic': 'query-time-probe',
                    'relationship': 'query-time-probe',
                },
            }
        except (KeyError, TypeError, ValueError, OSError, sqlite3.Error):
            raise ValueError(RESPONSE_ERROR) from None
        return _sanitize_result(payload, rows, self._allowed)

    def discover(self, query: str, *, source_ids=None, **options) -> dict:
        normalized = self.scope.normalize(source_ids)
        request = {'query': query, 'source_ids': list(normalized), **options}
        _authorize_request(request, self._allowed)
        return self._dispatch(
            self.registry.discover, query, source_ids=list(normalized), **options,
        )

    def read(self, source_id: str, path: str, **options) -> dict:
        request = {'source_id': source_id, 'path': path, **options}
        _authorize_request(request, self._allowed)
        return self._dispatch(self.registry.read_document, source_id, path, **options)

    def outline(self, source_id: str, path: str, **options) -> dict:
        request = {'source_id': source_id, 'path': path, **options}
        _authorize_request(request, self._allowed)
        return self._dispatch(self.registry.outline, source_id, path, **options)

    def expand(self, selections: list[dict], *, source_ids=None, **options) -> dict:
        normalized = self.scope.normalize(source_ids)
        request = {'selections': selections, 'source_ids': list(normalized), **options}
        _authorize_request(request, self._allowed)
        return self._dispatch(
            self.registry.expand, selections, source_ids=list(normalized), **options,
        )

    def validate_claims(
            self,
            claims: list[dict],
            *,
            source_ids=None,
            consumed=None,
            **options,
    ) -> dict:
        normalized = self.scope.normalize(source_ids)
        request = {
            'claims': claims,
            'source_ids': list(normalized),
            **({'consumed': consumed} if consumed is not None else {}),
            **options,
        }
        _authorize_request(request, self._allowed)
        arguments = {'source_ids': list(normalized), **options}
        if consumed is not None:
            arguments['consumed'] = consumed
        return self._dispatch(self.registry.validate_claims, claims, **arguments)
