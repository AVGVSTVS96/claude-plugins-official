---
name: solo
description: "Work on one hard mathematics problem in this session yourself, with no sub-agents: reason in stages, record each settled step in a notes file so that nothing written is lost if a response is cut off, and end with a self-contained proof.md. The usage is /math-proof:solo <the problem, stated in full, or the path of a file holding it>."
argument-hint: [DIR=run-directory] <problem statement | problem-file>
disable-model-invocation: true
disallowed-tools: WebSearch, WebFetch, AskUserQuestion
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(mkdir *), Bash(cp *), Bash(cmp *)
---

# math-proof: solo

You solve the problem yourself, in this session. There are no sub-agents and no rounds: just you, a notes
file and, at the end, proof.md.

**Arguments.** The invoking message reads: $ARGUMENTS
It gives the problem and, optionally, the run directory. Read it this way. A token of the form DIR=path at its
start sets the run directory; remove it. If what remains begins with the path of an existing file, that file is
the problem file; otherwise everything that remains, to the end of the message, IS the problem statement,
verbatim — mathematics, line breaks and all. The run directory DIR defaults to ./math-proof-solo under the
current directory; use DIR's absolute path everywhere below. If the message holds neither a readable problem
file nor any problem text, say so in one sentence and stop.

**Setup.** The run's files are DIR/problem.md (the problem), DIR/notes.md (your notes) and DIR/proof.md (the
deliverable). Create DIR with `mkdir -p`. If DIR/notes.md already exists, this problem was already being
worked on in DIR: check that DIR/problem.md is the same problem you were given (compare the text, ignoring
differences in whitespace and line endings; for a file, `cmp`) — if it differs, say in one sentence that DIR
holds work on a different problem and that DIR=<another directory> selects a fresh one, and stop; if it is the
same, the earlier session ended before it finished, and whatever reasoning it had not written down is lost:
read DIR/notes.md, and DIR/proof.md if it exists, and continue from the last point recorded there rather than
starting over. Otherwise put the problem at DIR/problem.md: if it came as a file, copy that file there byte for
byte with `cp`; if it came as text in the invoking message, Write exactly that text (nothing added, removed or
reworded). Then Read DIR/problem.md in full; it is the authoritative text of the problem. Use the shell for
nothing but that `mkdir`, `cp` and `cmp`.

**The task.** Solve the problem stated in DIR/problem.md; the deliverable is DIR/proof.md. After reasoning,
write your answer. This task runs as a conversation that can span many messages, each with a bounded output
allowance; a message that is cut off is normally followed by a request to continue, and only what you have
WRITTEN (not unwritten reasoning) is guaranteed to carry into the next message. So write your work product
out as you go, in a notes file, DIR/notes.md: whenever you settle something — a lemma and its proof, a
reduction, a dead end and why it is dead, the precise statement you are now attempting — write it down before
reasoning further. A partial answer is much more useful than none. Writing to the notes is not finishing —
keep going after each write. Important: each message's output allowance also covers your private reasoning,
and it is far smaller than a hard problem deserves — a message spent entirely on reasoning, with nothing
written, gets cut off, and unwritten reasoning should be assumed lost. So do not try to finish in one
message. Work in stages: early in EVERY message, before any long derivation, write your current plan and the
precise statement you are attempting to DIR/notes.md; then reason toward the next concrete intermediate
result, append it to the notes as soon as you have it, and continue. Many short written steps beat one long
unwritten one. If a message of yours is cut off, re-read DIR/notes.md and continue from the last thing
written there; never start over. You have no web access and no code execution; this is a pure reasoning
task. When the problem is resolved, or you have taken it as far as you can, write your complete solution to
DIR/proof.md. proof.md is read on its own by a referee who cannot open any other file (not your notes
either), so it must be self-contained: every argument the solution relies on is written out in full there.
Work unattended: there is no one to answer questions, so never stop to ask.

When DIR/proof.md is written, reply briefly: where proof.md is, and whether it resolves the problem
completely or, in proof.md's own words, what it leaves open.
