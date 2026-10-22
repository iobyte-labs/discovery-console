"""Tests for the Python reader, including the cross-language contract.

The interop test is the one that matters. The Worker encrypts in JavaScript and the send
path decrypts in Python; if the two ever disagree, a CV cannot be attached to the email it
was kept for, and nothing else in the suite would notice.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from cvcrypto import (  # noqa: E402
    CV_ENVELOPE_VERSION,
    EnvelopeError,
    UndecryptableError,
    decrypt_cv,
    encrypt_cv,
)

TEXT = b"CURRICULUM VITAE\nPharmacovigilance, QA/QC, GMP audits"


def a_key() -> str:
    return base64.b64encode(os.urandom(32)).decode("ascii")


def test_round_trip():
    key = a_key()
    envelope = encrypt_cv(TEXT, key, filename="CV.pdf", content_type="application/pdf")
    cv = decrypt_cv(envelope, key)
    assert cv.content == TEXT
    assert cv.filename == "CV.pdf"


def test_another_seekers_key_cannot_read_it():
    envelope = encrypt_cv(TEXT, a_key(), filename="CV.pdf", content_type="application/pdf")
    with pytest.raises(UndecryptableError):
        decrypt_cv(envelope, a_key())


def test_a_destroyed_key_leaves_the_ciphertext_unreadable():
    """The property the design rests on, stated as a test."""
    envelope = encrypt_cv(TEXT, a_key(), filename="CV.pdf", content_type="application/pdf")
    assert b"Pharmacovigilance" not in json.dumps(envelope).encode()
    with pytest.raises(UndecryptableError):
        decrypt_cv(envelope, a_key())


def test_tampering_is_rejected():
    key = a_key()
    envelope = encrypt_cv(TEXT, key, filename="CV.pdf", content_type="application/pdf")
    envelope["ciphertext"] = envelope["ciphertext"][:-4] + "AAAA"
    with pytest.raises(UndecryptableError):
        decrypt_cv(envelope, key)


def test_a_future_version_is_refused():
    key = a_key()
    envelope = encrypt_cv(TEXT, key, filename="CV.pdf", content_type="application/pdf")
    envelope["version"] = "eucd.cv/99"
    with pytest.raises(EnvelopeError, match="eucd.cv/99"):
        decrypt_cv(envelope, key)


def test_a_malformed_envelope_is_refused():
    with pytest.raises(EnvelopeError):
        decrypt_cv({"version": CV_ENVELOPE_VERSION}, a_key())
    with pytest.raises(EnvelopeError):
        decrypt_cv("not json at all", a_key())  # type: ignore[arg-type]


def test_a_short_key_is_refused():
    key = a_key()
    envelope = encrypt_cv(TEXT, key, filename="CV.pdf", content_type="application/pdf")
    with pytest.raises(EnvelopeError, match="expected 32"):
        decrypt_cv(envelope, base64.b64encode(b"short").decode())


@pytest.mark.skipif(
    subprocess.run(["which", "node"], capture_output=True).returncode != 0,
    reason="node is not installed",
)
def test_a_cv_encrypted_in_the_worker_decrypts_here(tmp_path):
    """The cross-language contract, exercised rather than assumed."""
    fixture = tmp_path / "interop.json"
    worker = Path(__file__).parent
    result = subprocess.run(
        ["node", "--test", "--test-name-pattern=interop fixture", str(worker)],
        capture_output=True,
        text=True,
        env={**os.environ, "INTEROP_FIXTURE": str(fixture)},
        cwd=worker,
    )
    assert fixture.exists(), f"node did not write the fixture:\n{result.stdout}\n{result.stderr}"

    blob = json.loads(fixture.read_text())
    cv = decrypt_cv(blob["envelope"], blob["key"])
    assert cv.content.decode() == blob["plaintext"]
    assert cv.content_type == "application/pdf"
