from __future__ import annotations

import threading
import time
import uuid
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime

from plotter_core.models import JobState, JobTiming, JobWarning


class JobCancelledError(Exception):
    pass


class StaleJobError(Exception):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat()


class CancellationToken:
    def __init__(self) -> None:
        self._cancelled = threading.Event()

    def cancel(self) -> None:
        self._cancelled.set()

    @property
    def cancelled(self) -> bool:
        return self._cancelled.is_set()

    def checkpoint(self) -> None:
        if self.cancelled:
            raise JobCancelledError


@dataclass(frozen=True)
class JobResult:
    result_hash: str
    cache_hit: bool = False
    warnings: tuple[JobWarning, ...] = ()
    result_project_revision: int | None = None


ProgressCallback = Callable[[str, int | None, int | None], None]
JobWork = Callable[[CancellationToken, ProgressCallback], JobResult]


class JobManager:
    def __init__(self, *, max_workers: int = 2, max_records: int = 200) -> None:
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="plotterapp-job",
        )
        self._max_records = max_records
        self._states: dict[str, JobState] = {}
        self._tokens: dict[str, CancellationToken] = {}
        self._futures: dict[str, Future[None]] = {}
        self._lock = threading.RLock()

    def submit(
        self,
        *,
        project_id: str,
        project_revision: int,
        operation: str,
        quality: str,
        input_hash: str,
        work: JobWork,
    ) -> JobState:
        job_id = uuid.uuid4().hex
        state = JobState(
            job_id=job_id,
            project_id=project_id,
            project_revision=project_revision,
            operation=operation,
            stage="queued",
            status="queued",
            quality=quality,
            progress=0,
            input_hash=input_hash,
            created_at=_now(),
        )
        token = CancellationToken()
        with self._lock:
            self._prune_records_locked()
            self._states[job_id] = state
            self._tokens[job_id] = token
            self._futures[job_id] = self._executor.submit(
                self._run,
                job_id,
                token,
                work,
                time.monotonic(),
            )
        return state

    def get(self, job_id: str) -> JobState:
        with self._lock:
            try:
                return self._states[job_id].model_copy(deep=True)
            except KeyError as error:
                raise FileNotFoundError(f"job {job_id} does not exist") from error

    def cancel(self, job_id: str) -> JobState:
        with self._lock:
            try:
                state = self._states[job_id]
                token = self._tokens[job_id]
            except KeyError as error:
                raise FileNotFoundError(f"job {job_id} does not exist") from error
            if state.status in {"succeeded", "cancelled", "failed", "stale"}:
                return state.model_copy(deep=True)
            token.cancel()
            future = self._futures.get(job_id)
            if future is not None and future.cancel():
                state = state.model_copy(
                    update={
                        "status": "cancelled",
                        "stage": "cancelled",
                        "cancel_requested": True,
                        "finished_at": _now(),
                    }
                )
            else:
                state = state.model_copy(update={"cancel_requested": True})
            self._states[job_id] = state
            return state.model_copy(deep=True)

    def shutdown(self) -> None:
        with self._lock:
            for token in self._tokens.values():
                token.cancel()
        self._executor.shutdown(wait=True, cancel_futures=True)

    def _run(
        self,
        job_id: str,
        token: CancellationToken,
        work: JobWork,
        queued_at: float,
    ) -> None:
        started = time.monotonic()
        with self._lock:
            state = self._states[job_id]
            if token.cancelled:
                self._states[job_id] = state.model_copy(
                    update={
                        "status": "cancelled",
                        "stage": "cancelled",
                        "cancel_requested": True,
                        "finished_at": _now(),
                    }
                )
                return
            self._states[job_id] = state.model_copy(
                update={
                    "status": "running",
                    "stage": "starting",
                    "started_at": _now(),
                    "timing": JobTiming(queued_ms=(started - queued_at) * 1000),
                }
            )

        def progress(stage: str, completed: int | None, total: int | None) -> None:
            token.checkpoint()
            fraction = self.get(job_id).progress
            if completed is not None and total is not None and total > 0:
                fraction = min(1.0, max(0.0, completed / total))
            with self._lock:
                current = self._states[job_id]
                self._states[job_id] = current.model_copy(
                    update={
                        "stage": stage,
                        "progress": fraction,
                        "completed_items": completed,
                        "total_items": total,
                    }
                )

        try:
            result = work(token, progress)
            token.checkpoint()
            finished = time.monotonic()
            with self._lock:
                current = self._states[job_id]
                self._states[job_id] = current.model_copy(
                    update={
                        "status": "succeeded",
                        "stage": "complete",
                        "progress": 1.0,
                        "result_hash": result.result_hash,
                        "result_project_revision": result.result_project_revision,
                        "cache_hit": result.cache_hit,
                        "warnings": list(result.warnings),
                        "finished_at": _now(),
                        "timing": current.timing.model_copy(
                            update={"run_ms": (finished - started) * 1000}
                        ),
                    }
                )
        except JobCancelledError:
            self._finish_exception(job_id, "cancelled", "cancelled", started)
        except StaleJobError as error:
            self._finish_exception(job_id, "stale", str(error) or "stale revision", started)
        except Exception as error:
            self._finish_exception(job_id, "failed", str(error), started)

    def _finish_exception(
        self,
        job_id: str,
        status: str,
        message: str,
        started: float,
    ) -> None:
        finished = time.monotonic()
        with self._lock:
            current = self._states[job_id]
            self._states[job_id] = current.model_copy(
                update={
                    "status": status,
                    "stage": status,
                    "cancel_requested": status == "cancelled" or current.cancel_requested,
                    "error": None if status == "cancelled" else message,
                    "finished_at": _now(),
                    "timing": current.timing.model_copy(
                        update={"run_ms": (finished - started) * 1000}
                    ),
                }
            )

    def _prune_records_locked(self) -> None:
        if len(self._states) < self._max_records:
            return
        terminal = [
            state
            for state in self._states.values()
            if state.status in {"succeeded", "cancelled", "failed", "stale"}
        ]
        terminal.sort(key=lambda state: state.finished_at or state.created_at)
        for state in terminal[: max(1, len(self._states) - self._max_records + 1)]:
            self._states.pop(state.job_id, None)
            self._tokens.pop(state.job_id, None)
            self._futures.pop(state.job_id, None)
