from __future__ import annotations

import os
from functools import lru_cache

import tiktoken
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel


class CountRequest(BaseModel):
    model: str | None = None
    text: str


class CountResponse(BaseModel):
    tokens: int


app = FastAPI(title="opencode-context-compression token counter")


@lru_cache(maxsize=64)
def encoding_for_model(model: str | None):
    if not model:
        return tiktoken.get_encoding("cl100k_base")
    try:
        return tiktoken.encoding_for_model(model)
    except KeyError:
        return tiktoken.get_encoding("cl100k_base")


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/count", response_model=CountResponse)
def count_tokens(request: CountRequest) -> CountResponse:
    encoding = encoding_for_model(request.model)
    return CountResponse(tokens=len(encoding.encode(request.text)))


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.environ.get("OPENCODE_CONTEXT_COMPRESSION_TOKEN_COUNTER_PORT", "40311")),
    )
