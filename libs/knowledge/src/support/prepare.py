import json
import sys
from pathlib import Path
from knowledge_agent.source_registry import SourceRegistry

state, root = map(Path, sys.argv[1:])
if not state.is_dir() or any(state.iterdir()):
    raise ValueError("setup requires empty fresh state")
registry = SourceRegistry(state)
source = registry.add(root, label="Temari isolated test/demo copies")
receipt = registry.refresh(source["id"])
if receipt["status"] != "complete":
    raise ValueError(f"setup incomplete: {receipt}")
print(json.dumps({"sourceId": source["id"], "receipt": receipt}))
