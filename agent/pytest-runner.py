"""Execute an existing Pytest selection and retain its observed outcomes."""

import json
import os
from pathlib import Path
import sys

import pytest


class Evidence:
    def __init__(self, file, case):
        self.file = Path(file).resolve()
        self.case = case
        self.selected = set()
        self.results = {}
        self.reason = None

    @pytest.hookimpl(trylast=True)
    def pytest_collection_finish(self, session):
        items = session.items
        if len(items) > 1000:
            self.reason = "The selected Pytest file contains more than 1,000 cases."
        elif any(item.path.resolve() != self.file for item in items):
            self.reason = "Pytest collected cases outside the selected file."
        elif self.case and (
            len(items) != 1 or items[0].nodeid.partition("::")[2] != self.case
        ):
            self.reason = "Pytest did not collect the exact selected case."
        if self.reason:
            pytest.exit(self.reason, returncode=4)
        self.selected = {item.nodeid for item in items}

    def pytest_runtest_logreport(self, report):
        if report.nodeid not in self.selected:
            self.reason = "Pytest reported a case outside the selection."
            return
        result = self.results.setdefault(
            report.nodeid, {"name": report.nodeid.partition("::")[2], "status": "incomplete"}
        )
        if report.failed:
            result.update(status="failed", message=report.longreprtext[-4500:])
        elif result["status"] != "failed":
            if report.skipped:
                result["status"] = "skipped"
            elif report.when == "call" and report.passed:
                result["status"] = "passed"


def main():
    file, case, output = sys.argv[1:]
    evidence = Evidence(file, case)
    selector = file + "::" + case if case else file
    sys.path.insert(0, os.getcwd())
    code = pytest.main(
        ["-o", "addopts=", "--color=no", "--tb=short", "-q", selector], plugins=[evidence]
    )
    if not evidence.reason and (not evidence.selected or evidence.selected != evidence.results.keys()):
        evidence.reason = "Pytest did not complete the selected cases."
    Path(output).write_text(
        json.dumps({"reason": evidence.reason, "results": list(evidence.results.values())}),
        encoding="utf-8",
    )
    return code


if __name__ == "__main__":
    sys.exit(main())
