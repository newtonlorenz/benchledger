import importlib.util
from pathlib import Path
import tarfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("symbols", Path(__file__).with_name("ios-symbols.py"))
symbols = importlib.util.module_from_spec(spec)
spec.loader.exec_module(symbols)


class SymbolSafety(unittest.TestCase):
    def test_reject_unsafe_tar_entries(self):
        for name in ("../escape.dSYM/file", "/absolute.dSYM/file"):
            with self.assertRaises(ValueError): symbols.safe_member(tarfile.TarInfo(name))
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
            member = tarfile.TarInfo("safe.dSYM/link"); member.type = kind
            with self.assertRaises(ValueError): symbols.safe_member(member)
        self.assertTrue(symbols.safe_member(tarfile.TarInfo("ios-arm64/React.framework.dSYM/Contents/Info.plist")))
        self.assertFalse(symbols.safe_member(tarfile.TarInfo("unrelated/file")))

    def test_pinned_artifacts_only(self):
        self.assertEqual(len(symbols.symbol_urls("0.86.3", "250829098.0.17")), 3)
        with self.assertRaises(ValueError): symbols.symbol_urls("../../other", "latest")

    def test_uuid_and_architecture_are_both_required(self):
        with patch.object(symbols.subprocess, "check_output", return_value="UUID: AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA (arm64) binary"):
            self.assertEqual(symbols.uuids(Path("binary")), {("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", "arm64")})
        with patch.object(symbols.subprocess, "check_output", return_value="no debug data"):
            with self.assertRaises(ValueError): symbols.uuids(Path("binary"))


if __name__ == "__main__": unittest.main()
