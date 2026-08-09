from __future__ import annotations

import threading
import time

from plotterapp_api.jobs import JobManager, JobResult


def test_job_manager_cancels_at_cooperative_checkpoint() -> None:
    manager = JobManager(max_workers=1)
    started = threading.Event()

    def work(token, progress) -> JobResult:
        started.set()
        for index in range(1000):
            progress("working", index, 1000)
            time.sleep(0.001)
            token.checkpoint()
        return JobResult(result_hash="finished")

    state = manager.submit(
        project_id="job-project",
        project_revision=1,
        operation="generate",
        quality="export",
        input_hash="input",
        work=work,
    )
    assert started.wait(timeout=1)
    manager.cancel(state.job_id)
    deadline = time.monotonic() + 2
    while manager.get(state.job_id).status not in {"cancelled", "failed"}:
        assert time.monotonic() < deadline
        time.sleep(0.01)
    cancelled = manager.get(state.job_id)
    manager.shutdown()
    assert cancelled.status == "cancelled"
    assert cancelled.cancel_requested is True
    assert cancelled.finished_at is not None
