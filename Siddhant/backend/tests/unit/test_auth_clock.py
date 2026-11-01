"""Pure tests (no database): login tokens and the server's clock.

Run without the DB fixtures:  .venv/Scripts/python -m pytest --noconftest tests/unit
Supabase stamps each token with its own clock; a server clock a little behind must not reject a token used right
after login (it did, 0.56 s behind: "not yet valid (iat)", and the app logged the user straight back out).
"""
import os
import sys
import time
from pathlib import Path

import jwt
import pytest

BACKEND = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("SUPABASE_URL", "http://supabase.test.invalid")

import auth  # noqa: E402

SECRET = "test-secret-for-local-tests-only-0123456789"


@pytest.fixture(autouse=True)
def hs256(monkeypatch):
    monkeypatch.setattr(auth, "JWT_SECRET", SECRET)


def token(iat_offset_s, exp_offset_s=3600):
    now = int(time.time())
    return jwt.encode({"sub": "u1", "aud": "authenticated", "iss": auth.ISSUER, "iat": now + iat_offset_s,
                       "exp": now + exp_offset_s, "app_metadata": {}, "user_metadata": {}}, SECRET, algorithm="HS256")


def test_a_token_issued_by_a_clock_slightly_ahead_is_accepted():
    for ahead in (1, 2, 20):
        assert auth.current_user(f"Bearer {token(ahead)}")["id"] == "u1"


def test_far_future_and_expired_tokens_are_still_rejected():
    with pytest.raises(auth.HTTPException) as future:
        auth.current_user(f"Bearer {token(600)}")
    assert future.value.status_code == 401 and "Invalid login" in future.value.detail
    with pytest.raises(auth.HTTPException) as expired:
        auth.current_user(f"Bearer {token(-7200, exp_offset_s=-60)}")
    assert expired.value.status_code == 401 and "expired" in expired.value.detail
