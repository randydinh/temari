"""Fixed-origin, GET-only profile consumer. Grants are local host receipts.

No profile secrets appear in CLI arguments, registry state, exceptions or repr.
The optional Temari integration is imported only during an authorized refresh.
"""
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import http.client
import json
import os
from pathlib import Path
import re
import ssl
import stat
import socket
import threading
import time
from urllib.parse import urlencode

from knowledge_agent.remote_sources import RemoteError

ORIGINS = {'shortcut': 'https://api.app.shortcut.com', 'notion': 'https://api.notion.com'}
PROFILE_KEYS = {'profile_id', 'service', 'environment', 'account_scope', 'kind', 'origin', 'account_alias'}
MAX_BODY = 4 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
MAX_REQUESTS = 1000
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'


def validate_profile(kind, profile):
    if (type(profile) is not dict or set(profile) != PROFILE_KEYS or
            any(not isinstance(v, str) or not v.strip() or len(v) > 256 or
                any(ord(c) < 32 for c in v) for v in profile.values()) or
            profile['service'] != kind or profile['origin'] != ORIGINS[kind] or
            profile['account_scope'] not in ('work', 'personal') or
            profile['kind'] not in ('api-key', 'bearer-token')):
        raise RemoteError('invalid-credential-profile')
    return dict(profile)


def load_grant(source):
    """Re-read the host's bounded decision, without consulting native secrets."""
    path = Path(source['grant_file']).expanduser().absolute()
    try:
        if any(p.is_symlink() for p in (path, *path.parents)):
            raise RemoteError('unsafe-grant-path')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
                    info.st_mode & 0o077 or info.st_size > 32000):
                raise RemoteError('unsafe-grant-file')
            grant = json.loads(stream.read(32001))
        issued = datetime.fromisoformat(grant['issued_at'])
        expires = datetime.fromisoformat(grant['expires_at'])
        now = datetime.now(timezone.utc)
        valid = (grant.get('revoked') is False and grant.get('method') == 'GET' and
            grant.get('kind') == source['kind'] and grant.get('selection') == source['selection'] and
            grant.get('profile') == source['credential_profile'] and
            issued.tzinfo is not None and expires.tzinfo is not None and issued <= now < expires and
            0 < (expires-issued).total_seconds() <= 14400 and
            all(isinstance(grant.get(k), str) and grant[k].strip() and len(grant[k]) <= 2000
                for k in ('grant_id', 'owner_request', 'consumer', 'purpose')))
        if not valid:
            raise RemoteError('grant-expired-revoked-or-scope-mismatch')
        return grant
    except (OSError, ValueError, KeyError, TypeError) as exc:
        if isinstance(exc, RemoteError):
            raise
        raise RemoteError('grant-unavailable-or-invalid') from None


class ProfileClient:
    def __init__(self, source, *, store=None):
        self.source = source
        self.profile = validate_profile(source['kind'], source['credential_profile'])
        self.grant = load_grant(source)
        self.requests = 0
        self.response_bytes = 0
        self.deadline = time.monotonic() + 180
        self.allowed_blocks = set(source['selection'].get('page_ids', []))
        self.discovered_blocks = set()
        try:
            if store is None:
                from temari.credentials import CredentialStore
                store = CredentialStore()
            inspected = store.inspect(self.profile['profile_id'])
            if any(inspected.get(k) != v for k, v in self.profile.items()):
                raise RemoteError('credential-profile-mismatch')
            material = store.resolve(self.profile['profile_id'],
                environment=self.profile['environment'], account_scope=self.profile['account_scope'],
                origin=self.profile['origin'], purpose=self.grant['purpose'],
                consumer=self.grant['consumer'], authorize=self._authorize)
            field = 'api_key' if self.profile['kind'] == 'api-key' else 'token'
            self._token = material.fields[field]
            if (not isinstance(self._token, str) or not 1 <= len(self._token) <= 8192 or
                    any(ord(c) <= 32 or ord(c) >= 127 for c in self._token)):
                raise RemoteError('invalid-credential-material')
        except RemoteError:
            raise
        except ImportError:
            raise RemoteError('credential-profile-adapter-unavailable') from None
        except Exception:
            raise RemoteError('credential-access-failed') from None

    def __repr__(self):
        return 'ProfileClient(<redacted>)'

    def _authorize(self, proposal):
        try:
            grant = load_grant(self.source)
            scope = json.loads(proposal.scope)
            valid = (grant == self.grant and proposal.capability == 'credential.use' and
                proposal.risk == 'read' and proposal.changes_authority is False and
                all(scope.get(k) == v for k, v in self.profile.items()) and
                scope.get('purpose') == grant['purpose'] and scope.get('consumer') == grant['consumer'])
            return {'type': 'allow', 'grant_id': grant['grant_id']} if valid else {'type': 'deny'}
        except Exception:
            return {'type': 'deny'}

    def allow_block(self, block_id):
        if block_id not in self.discovered_blocks and block_id not in self.allowed_blocks:
            raise RemoteError('block-not-observed-in-scope')
        self.allowed_blocks.add(block_id)

    def sanitize(self, value):
        if isinstance(value, str):
            return value.replace(self._token, '[REDACTED CREDENTIAL]')
        if isinstance(value, list):
            return [self.sanitize(x) for x in value]
        if isinstance(value, dict):
            return {k: self.sanitize(v) for k, v in value.items()}
        return value

    def get(self, path, params=None):
        if load_grant(self.source) != self.grant:
            raise RemoteError('grant-changed-during-refresh')
        params = params or {}
        if self.source['kind'] == 'shortcut':
            allowed = {f'/stories/{sid}' for sid in self.source['selection']['story_ids']}
            if path not in allowed or params:
                raise RemoteError('endpoint-not-admitted')
            prefix = '/api/v3'
        else:
            page = re.fullmatch('/pages/(' + UUID + ')', path)
            blocks = re.fullmatch('/blocks/(' + UUID + ')/children', path)
            if page and page[1] in self.source['selection']['page_ids'] and not params:
                pass
            elif blocks and blocks[1] in self.allowed_blocks:
                if (set(params) - {'page_size', 'start_cursor'} or
                        type(params.get('page_size', 100)) is not int or
                        not 1 <= params.get('page_size', 100) <= 100 or
                        ('start_cursor' in params and (not isinstance(params['start_cursor'], str) or
                            not 1 <= len(params['start_cursor']) <= 2048))):
                    raise RemoteError('pagination-parameters-refused')
            else:
                raise RemoteError('endpoint-not-admitted')
            prefix = '/v1'
        self.requests += 1
        remaining = self.deadline-time.monotonic()
        if self.requests > MAX_REQUESTS or remaining <= 0:
            raise RemoteError('request-budget-exceeded')
        headers = {'Accept': 'application/json'}
        if self.source['kind'] == 'shortcut':
            headers['Shortcut-Token'] = self._token
        else:
            headers.update({'Authorization': 'Bearer '+self._token, 'Notion-Version': '2026-03-11'})
        route = prefix + path + ('?' + urlencode(params) if params else '')
        connection = http.client.HTTPSConnection(self.profile['origin'].split('://')[1],
            timeout=min(25, remaining), context=ssl.create_default_context())
        transport_socket = []
        expired = threading.Event()

        def deadline_remaining():
            left = self.deadline-time.monotonic()
            if expired.is_set() or left <= 0:
                raise RemoteError('request-deadline-exceeded')
            return left

        def interrupt_socket():
            expired.set()
            sock = transport_socket[0] if transport_socket else connection.sock
            if sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

        timer = threading.Timer(remaining, interrupt_socket)
        timer.daemon = True
        try:
            timer.start()
            connection.connect()
            transport_socket.append(connection.sock)
            connection.sock.settimeout(min(25, deadline_remaining()))
            connection.request('GET', route, headers=headers)
            deadline_remaining()
            response = connection.getresponse()
            deadline_remaining()
            if response.status != 200:
                retry = None
                if response.status == 429:
                    value = response.getheader('Retry-After', '60')
                    try:
                        retry = max(0, int(value))
                    except (TypeError, ValueError):
                        try:
                            retry = max(0, int((parsedate_to_datetime(value)-datetime.now(timezone.utc)).total_seconds())+1)
                        except (TypeError, ValueError, OverflowError):
                            retry = 60
                    retry = min(retry, 86400)
                raise RemoteError('http-'+str(response.status), retry_after=retry)
            parts, received = [], 0
            while True:
                transport_socket[0].settimeout(min(25, deadline_remaining()))
                part = response.read1(min(65536, MAX_BODY+1-received))
                deadline_remaining()
                if not part:
                    break
                parts.append(part); received += len(part)
                if received > MAX_BODY:
                    raise RemoteError('response-size-limit')
            raw = b''.join(parts)
            self.response_bytes += len(raw)
            if len(raw) > MAX_BODY or self.response_bytes > MAX_TOTAL:
                raise RemoteError('response-size-limit')
            result = json.loads(raw)
            if not isinstance(result, (dict, list)):
                raise RemoteError('invalid-response-shape')
            # Children may be traversed only after their IDs were observed in an admitted read.
            if self.source['kind'] == 'notion' and isinstance(result, dict):
                for row in result.get('results', []):
                    if isinstance(row, dict) and row.get('object') == 'block' and isinstance(row.get('id'), str):
                        from uuid import UUID as ParseUUID
                        try:
                            self.discovered_blocks.add(str(ParseUUID(row['id'])))
                        except ValueError:
                            pass
            return result
        except RemoteError:
            raise
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise RemoteError('invalid-json') from None
        except (OSError, http.client.HTTPException):
            deadline_remaining()
            raise RemoteError('network-or-tls-error') from None
        finally:
            timer.cancel()
            connection.close()
