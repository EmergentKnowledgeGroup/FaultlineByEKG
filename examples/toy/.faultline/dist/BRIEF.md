FAULTLINE BRIEF  Parcelworks  FINISHED  pin tree 0eee0014e3
Parcels come in through intake, wait in a durable SQLite queue, and are claimed by a worker under a time-limited lease. The worker routes each one: book a carrier, park it on hold, or fail the attempt and retry with backoff. A report counts what happened.
Success means: A parcel is accepted once, gets a carrier label, and is counted as delivered in the report. Refusing, holding and failing for good are deliberate answers, not crashes.
35 boxes, 47 routes (5 inferred), 5 stages, 5 loops. Accounted: endings 21/21, branches 18/18, modules 11/11.
STAGES in order (id title: boxes; then -> stages it hands to)
 1 s_intake Intake: 10; A parcel request is checked, then refused or put in line. -> s_queue
 2 s_queue Queue: 6; Durable jobs in SQLite, claimed under a lease. -> s_work,s_trouble,s_report
 3 s_work Work: 6; The worker loop routes each claimed parcel. -> s_queue,s_trouble
 4 s_trouble Retry and hold: 7; Backoff retries, terminal failure, and parked parcels. -> s_work
 5 s_report Report: 6; Counts outcomes and saves the report file.
MAIN PATH 22: web.submit > intake.submit > intake.required > intake.weight > intake.format > intake.dedupe > intake.lane > intake.enqueue > queue.pending > work.loop > work.tick > queue.reclaim > queue.claim > queue.leased > work.route > work.book > queue.complete > queue.done > report.summarize > report.render > report.write > report.saved
LOOPS (limit = what bounds the repeat)
 l_retry Retry with backoff: limit MAX_ATTEMPTS tries per job (4 by default), then terminal…
 l_worker Worker loop: limit max_ticks or stop_when_idle; a running service sets neither
 l_report_write Report write retry: NO LIMIT SHOWN
 l_hold_customs Customs hold and release: limit Each lap needs a new operator request
 l_hold_address Address hold and answer: limit Each lap needs a new operator request
ENDINGS 5 (5 stop here, 0 hand back to their caller)
 success: report.saved
 failure: trouble.failed
 refusal: intake.refused
 neutral: work.lease_lost report.returned
SILENT FAILURES 1: a failure the map says only a log or nobody hears (faultline breaks --silent)
CANDIDATES 4 (suspected shapes, not confirmed; one question each)
 declared-never-produced:report.returned [report.returned] Outcome lists "returned_to_sender" but no ending in the code sets it: is it kept for later, or left over?
 can-only-go-back:trouble.hold_address [trouble.hold_address,trouble.release_refused] 1 road in, every road on leads back to the same 2 boxes: what lets flow out of trouble.hold_address reach an ending?
 ending-no-test:work.lease_lost [work.lease_lost] No test or run reached the outcome "stale" at parcelworks/worker.py:28: what would make it happen, and is it worth a…
 no-limit-loop:l_report_write [report.write,report.busy] Loop "Report write retry" shows no limit: what stops it?
NOT DRAWN YET: nothing the census lists
EVIDENCE: 2 walk(s); seen 32, proved 0, unexplored 4
NEXT: faultline where <box|file:line|symbol> | breaks | path <a> <b> | impact <box|file> | status
open: atlas.html#chart=whole
