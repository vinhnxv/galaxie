# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import argparse
import contextlib
import json
import sys

with contextlib.redirect_stdout(sys.stderr):
    import mlflow
    import pandas as pd
    from mlflow.entities import Trace
    from mlflow.genai.scorers import scorer


@scorer
def chat_usage_total(trace: Trace) -> int:
    return sum(
        span.get_attribute("mlflow.chat.tokenUsage").get("total_tokens", 0)
        for span in trace.search_spans(span_type="CHAT_MODEL")
        if span.get_attribute("mlflow.chat.tokenUsage") is not None
    )


@scorer
def chat_text_present(trace: Trace) -> bool:
    return any(
        bool(span.inputs) or bool(span.outputs)
        for span in trace.search_spans(span_type="CHAT_MODEL")
    )


@scorer
def root_io_present(inputs, outputs) -> bool:
    return bool(inputs) and bool(outputs)


def evaluate(args: argparse.Namespace) -> dict:
    mlflow.set_tracking_uri(args.tracking_uri)
    mlflow.set_experiment(experiment_id=args.experiment_id)
    frames = [
        mlflow.search_traces(
            experiment_ids=[args.experiment_id],
            filter_string="metadata.`mlflow.trace.session` = '"
            + session.replace("'", "''")
            + "'",
        )
        for session in args.session
    ]
    traces = pd.concat(frames, ignore_index=True)
    result = mlflow.genai.evaluate(
        data=traces,
        scorers=[chat_usage_total, chat_text_present, root_io_present],
    )
    names = ["chat_usage_total", "chat_text_present", "root_io_present"]
    rows = []
    table = result.result_df
    if table is not None:
        for _, row in table.iterrows():
            scores = {}
            for name in names:
                value = row.get(name + "/value")
                if pd.isna(value):
                    value = None
                elif hasattr(value, "item"):
                    value = value.item()
                scores[name] = value
            rows.append({"traceId": row["request_id"], "scores": scores})
    return {
        "mlflowVersion": mlflow.__version__,
        "expectedTraces": args.expected_traces,
        "traceIds": traces["trace_id"].tolist(),
        "rootIO": [
            {
                "traceId": row["trace_id"],
                "requestPresent": row["request"] is not None,
                "responsePresent": row["response"] is not None,
            }
            for _, row in traces.iterrows()
        ],
        "evaluateRows": len(rows),
        "rows": rows,
        "nonNullCounts": {
            name: sum(row["scores"][name] is not None for row in rows)
            for name in names
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tracking-uri", required=True)
    parser.add_argument("--experiment-id", required=True)
    parser.add_argument("--session", action="append", required=True)
    parser.add_argument("--expected-traces", type=int, required=True)
    args = parser.parse_args()
    with contextlib.redirect_stdout(sys.stderr):
        result = evaluate(args)
    print(json.dumps(result, separators=(",", ":"), allow_nan=False))


if __name__ == "__main__":
    main()
