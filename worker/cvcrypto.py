"""Reading a CV envelope written by the Worker.

The Worker encrypts; this decrypts. They are in different languages because the Worker runs
where the credentials live and the send path runs on the operator's own machine, so the
envelope format is the contract between them and is deliberately boring: JSON, base64,
AES-256-GCM, a version string. See docs/cv-intake.md.

Decryption needs the seeker's key, which lives in the Worker's key store. If the key has
been destroyed — because the seeker asked to be forgotten — this raises, and that is the
system working rather than failing.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Must match CV_ENVELOPE_VERSION in cvcrypto.js.
CV_ENVELOPE_VERSION = "eucd.cv/1"
_KEY_BYTES = 32


class EnvelopeError(Exception):
    """The envelope is not one this code can read."""


class UndecryptableError(Exception):
    """The key is wrong, the data was altered, or the key has been destroyed."""


@dataclass(frozen=True)
class CV:
    """A decrypted CV, with what an email attachment needs."""

    content: bytes
    filename: str
    content_type: str


def decrypt_cv(envelope: dict | str | Path, key_base64: str) -> CV:
    """Decrypts a CV envelope.

    `envelope` may be the parsed object, the JSON text, or a path to the committed file.
    """
    try:
        if isinstance(envelope, Path):
            envelope = json.loads(envelope.read_text(encoding="utf-8"))
        elif isinstance(envelope, str):
            envelope = json.loads(envelope)
    except json.JSONDecodeError as exc:
        # One exception type out of this module: a caller handling a bad envelope should not
        # have to know that it might arrive as unparsed text.
        raise EnvelopeError(f"envelope is not JSON: {exc}") from exc
    if not isinstance(envelope, dict):
        raise EnvelopeError("not a CV envelope")

    version = envelope.get("version")
    if version != CV_ENVELOPE_VERSION:
        raise EnvelopeError(
            f"CV envelope is {version or 'unversioned'}, this reads {CV_ENVELOPE_VERSION}"
        )

    try:
        key = base64.b64decode(key_base64, validate=True)
        iv = base64.b64decode(envelope["iv"], validate=True)
        ciphertext = base64.b64decode(envelope["ciphertext"], validate=True)
    except (KeyError, ValueError) as exc:
        raise EnvelopeError(f"envelope is malformed: {exc}") from exc

    if len(key) != _KEY_BYTES:
        raise EnvelopeError(f"key is {len(key)} bytes, expected {_KEY_BYTES}")

    try:
        # AES-GCM authenticates, so a tampered ciphertext raises rather than returning
        # plausible rubbish. That matters: this file gets attached to an email somebody
        # sends in their own name.
        content = AESGCM(key).decrypt(iv, ciphertext, None)
    except InvalidTag as exc:
        # Not distinguishing "wrong key" from "tampered" on purpose; saying which is free
        # information for anyone probing.
        raise UndecryptableError(
            "the CV could not be decrypted: the key is wrong, the data was altered, or the "
            "key has been destroyed because the seeker asked to be forgotten"
        ) from exc

    return CV(
        content=content,
        filename=envelope.get("filename") or "CV.pdf",
        content_type=envelope.get("content_type") or "application/pdf",
    )


def encrypt_cv(content: bytes, key_base64: str, *, filename: str, content_type: str) -> dict:
    """Writes an envelope. Used by tests, and by a local re-encryption if one is ever needed.

    The Worker is normally the only writer: it is where keys are generated and stored.
    """
    import os

    key = base64.b64decode(key_base64, validate=True)
    if len(key) != _KEY_BYTES:
        raise EnvelopeError(f"key is {len(key)} bytes, expected {_KEY_BYTES}")
    iv = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(iv, content, None)
    return {
        "version": CV_ENVELOPE_VERSION,
        "algorithm": "AES-256-GCM",
        "iv": base64.b64encode(iv).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        "filename": filename,
        "content_type": content_type,
    }
