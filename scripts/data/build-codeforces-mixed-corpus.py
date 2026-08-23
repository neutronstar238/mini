"""Build a bounded Codeforces browser-compatibility corpus.

The generator is intentionally deterministic.  It uses the local caches produced
by the first 908 replay when present and only falls back to Hugging Face URLs
when a cache is missing.  The corpus contains ten rows for each of OK, WA, CE,
RE, TLE and MLE, plus the public tests for every selected problem.

The default and selected_incorrect submission parquet files expose only a
``source`` field.  They are real submission-derived rows, but the dataset card
allows that source to have been adapted for newer runtimes.  The generator must
therefore mark those rows as unverified instead of manufacturing an
``og_source`` equality claim.  The selected_incorrect config is used only for
the additional MLE rows because the 908 default contest has no MLE rows.
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "tmp" / "codeforces-compat"
OUT = CACHE / "contest-mixed-verdicts-corpus.json"

# The previous data pass installed Polars in the temporary compatibility cache.
# A normal environment can instead provide Polars on PYTHONPATH.
try:
    import polars as pl
except ModuleNotFoundError:  # pragma: no cover - exercised only outside this workspace
    sys.path.insert(0, str(CACHE / "pylibs"))
    import polars as pl


SUBMISSION_COLUMNS = [
    "submission_id",
    "source",
    "contestId",
    "problem_index",
    "programmingLanguage",
    "verdict",
    "testset",
    "passedTestCount",
    "timeConsumedMillis",
    "memoryConsumedBytes",
    "creationTimeSeconds",
    "problem_id",
]


def remote_submission_url(shard: int) -> str:
    return (
        "https://huggingface.co/datasets/open-r1/codeforces-submissions/"
        f"resolve/main/data/train-{shard:05d}-of-00036.parquet"
    )


def load_default_908() -> pl.DataFrame:
    """Load the cached 908 slice, or make it once with Parquet pushdown."""

    path = CACHE / "contest-908-default.parquet"
    if path.exists():
        return pl.read_parquet(path)

    parts: list[pl.DataFrame] = []
    for shard in range(36):
        part = (
            pl.scan_parquet(remote_submission_url(shard))
            .filter(pl.col("contestId") == "908")
            .select(SUBMISSION_COLUMNS)
            .collect()
        )
        if part.height:
            parts.append(part)
    if not parts:
        raise RuntimeError("no contest 908 rows found in the default dataset")
    result = pl.concat(parts, how="vertical").unique("submission_id", keep="first")
    CACHE.mkdir(parents=True, exist_ok=True)
    result.write_parquet(path, compression="zstd")
    return result


def load_selected_incorrect() -> pl.DataFrame:
    path = CACHE / "selected_incorrect.parquet"
    if path.exists():
        return pl.read_parquet(path)
    url = (
        "https://huggingface.co/datasets/open-r1/codeforces-submissions/"
        "resolve/main/selected_incorrect/train-00000-of-00001.parquet"
    )
    result = pl.read_parquet(url)
    CACHE.mkdir(parents=True, exist_ok=True)
    result.write_parquet(path, compression="zstd")
    return result


def numeric_sorted(df: pl.DataFrame) -> pl.DataFrame:
    return (
        df.with_columns(pl.col("submission_id").cast(pl.Int64, strict=False).alias("_id"))
        .sort(["_id", "submission_id"])
        .drop("_id")
    )


def pick_rows(
    df: pl.DataFrame,
    *,
    verdict: str,
    contest: str,
    count: int,
    languages: Iterable[str],
    problem_id: str | None = None,
) -> list[dict[str, Any]]:
    """Pick rows deterministically while round-robining language labels."""

    query = df.filter((pl.col("contestId") == contest) & (pl.col("verdict") == verdict))
    if problem_id is not None:
        query = query.filter(pl.col("problem_id") == problem_id)

    by_language: dict[str, list[dict[str, Any]]] = {}
    for language in languages:
        rows = numeric_sorted(
            query.filter(pl.col("programmingLanguage") == language)
        ).to_dicts()
        if rows:
            by_language[language] = rows

    selected: list[dict[str, Any]] = []
    while len(selected) < count and by_language:
        for language in list(languages):
            rows = by_language.get(language)
            if not rows:
                continue
            selected.append(rows.pop(0))
            if not rows:
                by_language.pop(language, None)
            if len(selected) == count:
                break
    if len(selected) != count:
        available = query.height
        raise RuntimeError(
            f"not enough {verdict} rows for contest {contest}: "
            f"requested {count}, filtered rows {available}"
        )
    return selected


def normalize_row(
    row: dict[str, Any],
    *,
    fallback_contest: str | None = None,
    verified_original: bool = False,
) -> dict[str, Any]:
    """Normalize a submission without inventing unavailable provenance."""

    source = row.get("source")
    if not isinstance(source, str) or not source:
        raise ValueError(f"empty source for submission {row.get('submission_id')}")
    result = dict(row)
    if result.get("contestId") is None and fallback_contest is not None:
        result["contestId"] = fallback_contest
    if result.get("problem_id") is None and result.get("contestId") is not None:
        result["problem_id"] = f"{result['contestId']}/{result.get('problem_index', '')}"
    result["source"] = source
    if verified_original:
        result["og_source"] = source
        result["sourceOriginalStatus"] = "verified_source_equals_og_source"
    elif isinstance(result.get("og_source"), str):
        result["sourceOriginalStatus"] = (
            "verified_source_equals_og_source"
            if result["og_source"] == source
            else "dataset_source_differs_from_og_source"
        )
    else:
        result["og_source"] = None
        result["sourceOriginalStatus"] = "dataset_source_only_original_unverifiable"
    return result


def add_verdict(rows: list[dict[str, Any]], expected: str) -> None:
    for row in rows:
        row["verdict"] = expected


def load_existing_accepted() -> list[dict[str, Any]]:
    path = CACHE / "contest-908-corpus.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    # The previous selected_accepted export was checked against its og_source
    # column before this reduced corpus was written.
    return [normalize_row(row, fallback_contest="908", verified_original=True)
            for row in payload["sources"]]


def pick_accepted(rows: list[dict[str, Any]], language: str, count: int) -> list[dict[str, Any]]:
    candidates = sorted(
        (row for row in rows if row.get("programmingLanguage") == language),
        key=lambda row: int(row["submission_id"]),
    )
    if len(candidates) < count:
        raise RuntimeError(f"not enough accepted {language} rows")
    return candidates[:count]


def load_tests(path: Path, url: str) -> list[dict[str, Any]]:
    if path.exists():
        table = pl.read_parquet(path)
    else:
        table = pl.read_parquet(url)
        path.parent.mkdir(parents=True, exist_ok=True)
        table.write_parquet(path, compression="zstd")
    return [
        {
            "problem_id": row["problem_id"],
            "input": row["input"],
            "output": row["output"],
            "test_i": int(row["test_i"]),
        }
        for row in table.select(["problem_id", "input", "output", "test_i"]).to_dicts()
    ]


def bound_tests(tests: list[dict[str, Any]], max_per_problem: int) -> list[dict[str, Any]]:
    """Keep a small deterministic slice for cross-contest MLE probes.

    The complete 914/E generated set contains very large serialized inputs and
    outputs.  The 908 baseline keeps all 103 existing tests; additional
    contests use the first four tests plus the largest-input test so the MLE
    probes remain runnable without embedding a 120 MB JSON fixture.
    """

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for test in tests:
        grouped[test["problem_id"]].append(test)
    bounded: list[dict[str, Any]] = []
    for problem_id, rows in grouped.items():
        rows = sorted(rows, key=lambda row: int(row["test_i"]))
        if len(rows) > max_per_problem:
            first = rows[: max_per_problem - 1]
            largest = max(rows, key=lambda row: len(row.get("input", "").encode("utf-8")))
            rows = sorted({row["test_i"]: row for row in [*first, largest]}.values(),
                          key=lambda row: int(row["test_i"]))
        bounded.extend(rows)
    return bounded


def main() -> None:
    default_908 = load_default_908()
    incorrect = load_selected_incorrect()
    accepted = load_existing_accepted()

    sources: list[dict[str, Any]] = []

    # Exactly ten accepted rows, deliberately retaining C and C11 coverage.
    for language, count in [
        ("C++14 (GCC 6-32)", 2),
        ("GNU C++", 1),
        ("GNU C++11", 1),
        ("Python 3", 1),
        ("Java 8", 1),
    ]:
        selected = pick_accepted(accepted, language, count)
        add_verdict(selected, "OK")
        sources.extend(selected)
    for language in ("GNU C", "GNU C11"):
        sources.extend(
            normalize_row(row, fallback_contest="908")
            for row in numeric_sorted(
                default_908.filter(
                    (pl.col("verdict") == "OK")
                    & (pl.col("programmingLanguage") == language)
                )
            ).head(2).to_dicts()
        )

    # Ten each of the four non-OK outcomes available in the 908 default slice.
    for verdict in [
        "WRONG_ANSWER",
        "COMPILATION_ERROR",
        "RUNTIME_ERROR",
        "TIME_LIMIT_EXCEEDED",
    ]:
        sources.extend(
            normalize_row(row)
            for row in pick_rows(
                default_908,
                verdict=verdict,
                contest="908",
                count=10,
                languages=["Python 3", "PyPy 3", "PyPy 3-64"],
            )
        )

    # 908 has no MLE rows.  Use ten real MLE rows from the public
    # selected_incorrect subset and include their matching public tests below.
    for contest, problem, count, languages in [
        ("914", "914/E", 4, ["C++14 (GCC 6-32)", "GNU C++11"]),
        ("573", "573/B", 2, ["GNU C++11"]),
        ("955", "955/F", 2, ["C++14 (GCC 6-32)"]),
        ("608", "608/B", 2, ["Python 3", "PyPy 3", "PyPy 3-64"]),
    ]:
        sources.extend(
            normalize_row(row)
            for row in pick_rows(
                incorrect,
                verdict="MEMORY_LIMIT_EXCEEDED",
                contest=contest,
                problem_id=problem,
                count=count,
                languages=languages,
            )
        )

    # Replace the old duplicate-free source list with a stable ID order while
    # retaining verdict/language strata in the metadata and summaries.
    unique: dict[str, dict[str, Any]] = {}
    for row in sources:
        submission_id = str(row["submission_id"])
        if submission_id in unique:
            raise RuntimeError(f"duplicate submission_id selected: {submission_id}")
        unique[submission_id] = row
    sources = sorted(unique.values(), key=lambda row: int(row["submission_id"]))

    tests: list[dict[str, Any]] = []
    tests.extend(json.loads((CACHE / "contest-908-corpus.json").read_text(encoding="utf-8"))["tests"])
    for contest, file_name, problem_ids in [
        ("914", "test_cases_0914_subset.parquet", {"914/E"}),
        ("573", "test_cases_0573_subset.parquet", {"573/B"}),
        ("955", "test_cases_0955_subset.parquet", {"955/F"}),
        ("608", "test_cases_0608_subset.parquet", {"608/B"}),
    ]:
        url = (
            "https://huggingface.co/datasets/open-r1/codeforces/resolve/main/"
            f"generated_tests/test_cases_{contest}.parquet"
        )
        loaded = load_tests(CACHE / file_name, url)
        loaded = [test for test in loaded if test["problem_id"] in problem_ids]
        tests.extend(bound_tests(loaded, max_per_problem=5))

    # A test must exist for every non-synthetic source in this corpus.
    tests_by_problem = defaultdict(int)
    for test in tests:
        tests_by_problem[test["problem_id"]] += 1
    missing = sorted(
        {row["problem_id"] for row in sources if not tests_by_problem[row["problem_id"]]}
    )
    if missing:
        raise RuntimeError(f"missing public tests for selected problems: {missing}")

    verdict_counts = Counter(str(row["verdict"]) for row in sources)
    language_counts = Counter(str(row["programmingLanguage"]) for row in sources)
    contest_counts = Counter(str(row["contestId"]) for row in sources)
    provenance_counts = Counter(str(row["sourceOriginalStatus"]) for row in sources)
    payload = {
        "schemaVersion": 2,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "contestId": "908+914+573+955+608",
        "sourceDataset": {
            "name": "open-r1/codeforces-submissions",
            "defaultConfig": "contest 908 rows from data/train-*",
            "mleConfig": "selected_incorrect (908 has no MLE rows)",
            "license": "ODC-By-4.0 / CC-BY-4.0 as published by the dataset",
        },
        "testDataset": "open-r1/codeforces generated_tests",
        "selection": {
            "deterministic": True,
            "perVerdict": 10,
            "submissionIdsUnique": True,
            "sourceProvenance": dict(sorted(provenance_counts.items())),
            "note": (
                "Default/selected_incorrect expose only source, and the dataset card "
                "allows runtime adaptations. Those rows are submission-derived but "
                "their byte-for-byte original source is not independently verifiable."
            ),
        },
        "summary": {
            "sources": len(sources),
            "tests": len(tests),
            "byVerdict": dict(sorted(verdict_counts.items())),
            "byLanguage": dict(sorted(language_counts.items())),
            "byContest": dict(sorted(contest_counts.items())),
        },
        "sources": sources,
        "tests": tests,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload["summary"], ensure_ascii=False, indent=2))
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
