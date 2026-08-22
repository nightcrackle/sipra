from __future__ import annotations

import json

import pytest

from sipra_core.errors import ErrorCode, SipraError
from sipra_core.protocol import (
    MAX_LINE_BYTES,
    PROTOCOL_VERSION,
    decode_request,
    encode_error,
    encode_event,
    encode_response,
    optional,
    require,
)


class TestDecodeRequest:
    def test_decodes_a_well_formed_request(self):
        request = decode_request('{"id":"7","method":"ping","params":{"a":1}}')
        assert (request.id, request.method, request.params) == ("7", "ping", {"a": 1})

    def test_missing_params_defaults_to_empty_dict(self):
        assert decode_request('{"id":"1","method":"ping"}').params == {}

    def test_null_params_defaults_to_empty_dict(self):
        assert decode_request('{"id":"1","method":"ping","params":null}').params == {}

    def test_surrounding_whitespace_is_tolerated(self):
        assert decode_request('  {"id":"1","method":"ping"}  \n').id == "1"

    @pytest.mark.parametrize(
        "line",
        [
            "",
            "   ",
            "not json",
            "[1,2,3]",
            '"a string"',
            "42",
            '{"method":"ping"}',
            '{"id":"","method":"ping"}',
            '{"id":1,"method":"ping"}',
            '{"id":"1"}',
            '{"id":"1","method":""}',
            '{"id":"1","method":123}',
            '{"id":"1","method":"ping","params":[1]}',
        ],
    )
    def test_rejects_malformed_input(self, line):
        with pytest.raises(SipraError) as info:
            decode_request(line)
        assert info.value.code == ErrorCode.BAD_REQUEST

    def test_rejects_an_oversized_line(self):
        payload = json.dumps({"id": "1", "method": "ping", "params": {"blob": "x" * MAX_LINE_BYTES}})
        with pytest.raises(SipraError) as info:
            decode_request(payload)
        assert info.value.code == ErrorCode.BAD_REQUEST


class TestEncoding:
    def test_response_round_trips(self):
        decoded = json.loads(encode_response("3", {"value": 1}))
        assert decoded == {"id": "3", "ok": True, "result": {"value": 1}}

    def test_error_includes_code_and_details(self):
        error = SipraError(ErrorCode.FILE_NOT_FOUND, "gone", {"path": "x.wav"})
        decoded = json.loads(encode_error("4", error))
        assert decoded["ok"] is False
        assert decoded["error"]["code"] == ErrorCode.FILE_NOT_FOUND
        assert decoded["error"]["details"] == {"path": "x.wav"}

    def test_error_without_an_id_omits_the_field(self):
        decoded = json.loads(encode_error(None, SipraError(ErrorCode.INTERNAL, "boom")))
        assert "id" not in decoded

    def test_event_encodes_with_and_without_an_id(self):
        assert json.loads(encode_event("ready", {"v": 1}))["event"] == "ready"
        assert json.loads(encode_event("progress", {}, "9"))["id"] == "9"

    @pytest.mark.parametrize(
        "payload",
        [
            {"text": "line one\nline two"},
            {"text": "carriage\r\nreturn"},
            {"text": "unicode ☃ and emoji 🎧"},
            {"text": 'quotes " and \\ backslashes'},
        ],
    )
    def test_encoded_lines_never_contain_a_raw_newline(self, payload):
        """A newline inside a payload would desynchronise the whole stream."""
        line = encode_response("1", payload)
        assert "\n" not in line and "\r" not in line
        assert json.loads(line)["result"] == payload

    def test_non_serialisable_values_fall_back_to_str(self):
        from pathlib import Path

        decoded = json.loads(encode_response("1", {"path": Path("/tmp/x.wav")}))
        assert decoded["result"]["path"].endswith("x.wav")


class TestParameterValidation:
    def test_require_returns_the_value(self):
        assert require({"path": "a.wav"}, "path", str) == "a.wav"

    def test_require_reports_a_missing_parameter(self):
        with pytest.raises(SipraError) as info:
            require({}, "path", str)
        assert info.value.code == ErrorCode.INVALID_PARAMS
        assert "path" in info.value.message

    def test_require_reports_a_wrong_type(self):
        with pytest.raises(SipraError) as info:
            require({"path": 5}, "path", str)
        assert info.value.code == ErrorCode.INVALID_PARAMS

    def test_require_rejects_a_bool_where_a_number_is_expected(self):
        """`True` is an int in Python; accepting it here would let
        `{"shifts": true}` through as `shifts=1`."""
        with pytest.raises(SipraError):
            require({"shifts": True}, "shifts", int)

    def test_require_accepts_a_bool_when_bool_is_requested(self):
        assert require({"flag": True}, "flag", bool) is True

    def test_optional_returns_the_default_when_absent_or_null(self):
        assert optional({}, "device", str, "cpu") == "cpu"
        assert optional({"device": None}, "device", str, "cpu") == "cpu"

    def test_optional_still_type_checks_when_present(self):
        with pytest.raises(SipraError):
            optional({"device": 1}, "device", str, "cpu")


def test_protocol_version_is_pinned():
    """A bump here must be paired with a change in the Electron client."""
    assert PROTOCOL_VERSION == 1
