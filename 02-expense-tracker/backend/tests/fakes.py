from dataclasses import dataclass, field


@dataclass
class InMemoryStorage:
    """Receipt storage double that keeps blobs in memory and records each call."""

    blobs: dict[str, bytes] = field(default_factory=dict)
    calls: list[tuple[str, str]] = field(default_factory=list)

    def put(self, key: str, data: bytes, content_type: str) -> None:
        self.calls.append(("put", key))
        self.blobs[key] = data

    def get(self, key: str) -> bytes:
        self.calls.append(("get", key))
        return self.blobs[key]

    def delete(self, key: str) -> None:
        self.calls.append(("delete", key))
        self.blobs.pop(key, None)
