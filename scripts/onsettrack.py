#!/usr/bin/env python3
"""The onset track: where each word of a recording starts, and where it stops.

One line of comma-separated seconds — one mark per word, plus a final mark for
the end of the last word. That is PocketTorah's label format, which is why a
reading built from their recordings and one built from a phone recording go
through the same code from here on.

A mark may also be written as two times, `end-start`:

    13.920,15.060,17.340-17.980,19.200

meaning the word before that mark stops at 17.340 and the word after it begins
at 17.980. The stretch between belongs to no word — a false start, a cough, an
aside to the room — so nothing plays it and nothing measures its pitch. Those
cuts are made by ear in scripts/label.html.

Both lists this module returns are indexed by MARK, not by word: for N words
there are N+1 marks, `starts[i]` opens word i and `ends[i]` closes word i-1.
An uncut mark has starts[i] == ends[i], which is every mark in every track
PocketTorah publishes. A consumer that wants word k reads starts[k]..ends[k+1].
"""


def parse(text):
    """Read a track. Returns (starts, ends), both indexed by mark."""
    starts, ends = [], []
    for field in text.replace("\n", ",").split(","):
        field = field.strip()
        if not field:
            continue
        if "-" in field:
            a, b = field.split("-", 1)
            end, start = float(a), float(b)
        else:
            end = start = float(field)
        starts.append(start)
        ends.append(end)
    return starts, ends


def dump(starts, ends=None):
    """Write a track (see parse). Cuts appear only where there is one."""
    ends = ends if ends is not None else starts
    out = []
    for start, end in zip(starts, ends):
        out.append(f"{end:.3f}-{start:.3f}" if round(end, 3) != round(start, 3)
                   else f"{start:.3f}")
    return ",".join(out) + "\n"


def check(starts, ends):
    """The one invariant: time only moves forward, mark by mark and within a
    mark. Returns an error string, or None when the track is sound."""
    if len(starts) != len(ends):
        return f"{len(starts)} starts but {len(ends)} ends"
    for i, (start, end) in enumerate(zip(starts, ends)):
        if end > start + 1e-6:
            return f"mark {i}: cut ends at {end:.3f}, after its start {start:.3f}"
        if i and starts[i - 1] > end + 1e-6:
            return f"mark {i}: word {i - 1} would end at {end:.3f}, before it starts"
    return None


def cuts(starts, ends):
    """The stretches that belong to no word, as (from, to) seconds."""
    return [(ends[i], starts[i]) for i in range(len(starts))
            if round(starts[i], 3) > round(ends[i], 3)]
