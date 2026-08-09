# Third-party notices

## Bundled fonts

`fonts/FrankRuehlCLM-Medium.ttf`, `fonts/FrankRuehlCLM-Bold.ttf` and
`fonts/StamAshkenazCLM.ttf` are from the [Culmus Project](https://culmus.sourceforge.io/),
by Maxim Iorsh and Yoram Gnat, under the GNU General Public License with the font
exception clause.

`fonts/ShlomoStam.ttf` is Shlomo Stam by Shlomo Orbach (2011), a derivative of
Ezra SIL SR, under the SIL Open Font License 1.1. The full licence and copyright
notice — which the OFL requires to travel with the font — is in
`fonts/ShlomoStam-OFL.txt`, along with a note about the contradictory
non-commercial boilerplate the build tool left in the binary's Windows name
record.

`fonts/ShlomoSemiStam.ttf` is Shlomo SemiStam by the same author, under the same
OFL 1.1 terms (see `fonts/ShlomoStam-OFL.txt`). It is the de-crowned sibling of
Shlomo Stam: same scribal letterforms and mark positioning, without the tagin
on שעטנז גץ. Used for the pointed Torah-column surface.

### WOFF2 conversions

Each of the faces above is also redistributed as a `.woff2` file next to
the `.ttf` it came from (`fonts/ShlomoStam.woff2`,
`fonts/ShlomoSemiStam.woff2`, `fonts/StamAshkenazCLM.woff2`,
`fonts/FrankRuehlCLM-Medium.woff2`, `fonts/FrankRuehlCLM-Bold.woff2`). These were
produced from the original `.ttf` files with fontTools, as a
container/compression change only: same glyphs, same character map, same
`GSUB`/`GPOS`/`GDEF` layout tables, same family and style names, nothing
subsetted or redrawn. The originals are kept alongside them.

The same licences govern the converted files as the originals they derive from —
the GNU GPL with font exception for the Culmus faces, and the OFL 1.1 for the
Shlomo faces. The OFL counts a change of format as a Modified Version, but its
Reserved Font Names here are "SIL" and "Ezra" (see `fonts/ShlomoStam-OFL.txt`),
neither of which these fonts or their conversions use, so the names
"Shlomo Stam" / "Shlomo SemiStam" are retained.

## tikkun.io Torah page data

`data/tikkun-torah-245.json` contains Torah page and line layout data derived
from [tikkun.io](https://github.com/akivajgordon/tikkun.io), commit
`57ba104e8de055cf92d3cf6aa91245bd92b34d60`.

The MIT License (MIT)

Copyright (c) 2015 Akiva Gordon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
