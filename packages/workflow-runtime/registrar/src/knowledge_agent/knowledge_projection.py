from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import StrEnum
import hashlib
import json
from pathlib import PurePosixPath
import re
from typing import NewType

from knowledge_agent.knowledge_cache import canonical


KnowledgeGenerationID = NewType("KnowledgeGenerationID", str)
ConceptID = NewType("ConceptID", str)
RelationshipID = NewType("RelationshipID", str)

MAX_CONCEPTS = 500
MAX_RELATIONSHIPS = 1000
MAX_BODY_BYTES = 65536
MAX_GENERATION_BYTES = 8 * 1024 * 1024
_KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,255}\Z")


class ProvenanceClass(StrEnum):
    EXTRACTED = "extracted"
    INFERRED = "inferred"
    AMBIGUOUS = "ambiguous"


@dataclass(frozen=True)
class SourceAnchor:
    source_id: str
    path: str
    source_sha256: str
    text_start: int
    text_end: int
    line_start: int
    line_end: int


@dataclass(frozen=True)
class ConceptDraft:
    local_key: str
    concept_type: str
    title: str
    body: str
    anchor: SourceAnchor
    provenance: ProvenanceClass


@dataclass(frozen=True)
class RelationshipDraft:
    local_key: str
    relationship_type: str
    subject_key: str
    object_key: str
    anchor: SourceAnchor
    provenance: ProvenanceClass


@dataclass(frozen=True)
class KnowledgeBatch:
    source_id: str
    source_generation: str
    extractor_revision: str
    concepts: tuple[ConceptDraft, ...]
    relationships: tuple[RelationshipDraft, ...]


@dataclass(frozen=True)
class Concept:
    id: ConceptID
    local_key: str
    concept_type: str
    title: str
    body: str
    anchor: SourceAnchor
    provenance: ProvenanceClass


@dataclass(frozen=True)
class Relationship:
    id: RelationshipID
    local_key: str
    relationship_type: str
    subject_id: ConceptID
    object_id: ConceptID
    anchor: SourceAnchor
    provenance: ProvenanceClass


@dataclass(frozen=True)
class KnowledgeGeneration:
    schema: int
    id: KnowledgeGenerationID
    source_id: str
    source_generation: str
    extractor_revision: str
    concepts: tuple[Concept, ...]
    relationships: tuple[Relationship, ...]

    def concept_id(self, local_key: str) -> ConceptID:
        return next(row.id for row in self.concepts if row.local_key == local_key)

    def relationship_id(self, local_key: str) -> RelationshipID:
        return next(row.id for row in self.relationships if row.local_key == local_key)


def _digest(value) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def _anchor(value: SourceAnchor) -> dict:
    return asdict(value)


def _record_anchor(value):
    return SourceAnchor(**value)


def _check_text(value, name, limit=256):
    if not isinstance(value, str) or not value or len(value.encode()) > limit:
        raise ValueError(f"{name} must be nonempty and at most {limit} bytes")


def _check_key(value, name):
    if not isinstance(value, str) or not _KEY.fullmatch(value) or ".." in value.split("/"):
        raise ValueError(f"invalid {name}")


def _check_anchor(value: SourceAnchor, source_id: str):
    if not isinstance(value, SourceAnchor) or value.source_id != source_id:
        raise ValueError("anchor source mismatch")
    path = PurePosixPath(value.path) if isinstance(value.path, str) else None
    if (path is None or not value.path or "\\" in value.path or "\x00" in value.path
            or path.is_absolute() or value.path != path.as_posix() or ".." in path.parts
            or len(value.path.encode()) > 4096):
        raise ValueError("invalid anchor path")
    if not re.fullmatch(r"[0-9a-f]{64}", value.source_sha256):
        raise ValueError("anchor hash must be SHA-256")
    if (type(value.text_start) is not int or type(value.text_end) is not int
            or value.text_start < 0 or value.text_end <= value.text_start
            or type(value.line_start) is not int or type(value.line_end) is not int
            or value.line_start < 1 or value.line_end < value.line_start):
        raise ValueError("anchor span is invalid")


def _payload(generation: KnowledgeGeneration) -> dict:
    return {
        "schema": generation.schema,
        "source_id": generation.source_id,
        "source_generation": generation.source_generation,
        "extractor_revision": generation.extractor_revision,
        "concepts": [{
            "id": row.id,
            "local_key": row.local_key,
            "concept_type": row.concept_type,
            "title": row.title,
            "body": row.body,
            "anchor": _anchor(row.anchor),
            "provenance": row.provenance.value,
        } for row in generation.concepts],
        "relationships": [{
            "id": row.id,
            "local_key": row.local_key,
            "relationship_type": row.relationship_type,
            "subject_id": row.subject_id,
            "object_id": row.object_id,
            "anchor": _anchor(row.anchor),
            "provenance": row.provenance.value,
        } for row in generation.relationships],
    }


def normalize_batch(batch: KnowledgeBatch) -> KnowledgeGeneration:
    if not isinstance(batch, KnowledgeBatch):
        raise ValueError("knowledge batch is required")
    _check_text(batch.source_id, "source ID", 80)
    _check_text(batch.source_generation, "source generation", 256)
    _check_text(batch.extractor_revision, "extractor revision", 256)
    if len(batch.concepts) > MAX_CONCEPTS or len(batch.relationships) > MAX_RELATIONSHIPS:
        raise ValueError("knowledge batch exceeds record limits")

    concepts = []
    keys = set()
    for draft in batch.concepts:
        if not isinstance(draft, ConceptDraft):
            raise ValueError("invalid concept draft")
        _check_key(draft.local_key, "concept key")
        _check_text(draft.concept_type, "concept type")
        _check_text(draft.title, "concept title", 1024)
        if not isinstance(draft.body, str) or len(draft.body.encode()) > MAX_BODY_BYTES:
            raise ValueError("concept body exceeds limit")
        _check_anchor(draft.anchor, batch.source_id)
        if draft.local_key in keys:
            raise ValueError("duplicate concept key")
        keys.add(draft.local_key)
        identity = ConceptID("concept:" + _digest([batch.source_id, draft.anchor.path, draft.local_key]))
        concepts.append(Concept(identity, draft.local_key, draft.concept_type, draft.title, draft.body,
                                draft.anchor, ProvenanceClass(draft.provenance)))
    by_key = {row.local_key: row.id for row in concepts}

    relationships = []
    relation_keys = set()
    for draft in batch.relationships:
        if not isinstance(draft, RelationshipDraft):
            raise ValueError("invalid relationship draft")
        _check_key(draft.local_key, "relationship key")
        _check_text(draft.relationship_type, "relationship type")
        _check_anchor(draft.anchor, batch.source_id)
        if draft.local_key in relation_keys:
            raise ValueError("duplicate relationship key")
        if draft.subject_key not in by_key or draft.object_key not in by_key:
            raise ValueError("relationship endpoint is missing")
        relation_keys.add(draft.local_key)
        identity = RelationshipID("relationship:" + _digest(
            [batch.source_id, draft.anchor.path, draft.local_key]))
        relationships.append(Relationship(identity, draft.local_key, draft.relationship_type,
            by_key[draft.subject_key], by_key[draft.object_key], draft.anchor,
            ProvenanceClass(draft.provenance)))

    blank = KnowledgeGeneration(1, KnowledgeGenerationID(""), batch.source_id, batch.source_generation,
                                batch.extractor_revision, tuple(sorted(concepts, key=lambda row: row.id)),
                                tuple(sorted(relationships, key=lambda row: row.id)))
    identity = KnowledgeGenerationID("kg1:" + _digest(_payload(blank)))
    result = KnowledgeGeneration(blank.schema, identity, blank.source_id, blank.source_generation,
                                 blank.extractor_revision, blank.concepts, blank.relationships)
    if len(canonical(generation_to_dict(result))) > MAX_GENERATION_BYTES:
        raise ValueError("knowledge generation exceeds payload limit")
    return result


def generation_to_dict(generation: KnowledgeGeneration) -> dict:
    return {"id": generation.id, **_payload(generation)}


def generation_from_dict(value) -> KnowledgeGeneration:
    if not isinstance(value, dict) or set(value) != {
            "id", "schema", "source_id", "source_generation", "extractor_revision", "concepts", "relationships"}:
        raise ValueError("invalid stored knowledge generation")
    try:
        concepts = tuple(Concept(ConceptID(row["id"]), row["local_key"], row["concept_type"], row["title"],
            row["body"], _record_anchor(row["anchor"]), ProvenanceClass(row["provenance"]))
            for row in value["concepts"])
        relationships = tuple(Relationship(RelationshipID(row["id"]), row["local_key"], row["relationship_type"],
            ConceptID(row["subject_id"]), ConceptID(row["object_id"]), _record_anchor(row["anchor"]),
            ProvenanceClass(row["provenance"])) for row in value["relationships"])
        generation = KnowledgeGeneration(value["schema"], KnowledgeGenerationID(value["id"]), value["source_id"],
            value["source_generation"], value["extractor_revision"], concepts, relationships)
    except (KeyError, StopIteration, TypeError, ValueError) as exc:
        raise ValueError("invalid stored knowledge generation") from exc
    rebuilt = normalize_batch(KnowledgeBatch(generation.source_id, generation.source_generation,
        generation.extractor_revision,
        tuple(ConceptDraft(row.local_key, row.concept_type, row.title, row.body, row.anchor, row.provenance)
              for row in generation.concepts),
        tuple(RelationshipDraft(row.local_key, row.relationship_type,
              next(c.local_key for c in generation.concepts if c.id == row.subject_id),
              next(c.local_key for c in generation.concepts if c.id == row.object_id),
              row.anchor, row.provenance) for row in generation.relationships)))
    if rebuilt != generation:
        raise ValueError("stored knowledge generation integrity mismatch")
    return generation


def generation_bytes(generation: KnowledgeGeneration) -> bytes:
    return canonical(generation_to_dict(generation))


def generation_json(generation: KnowledgeGeneration) -> str:
    return json.dumps(generation_to_dict(generation), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
