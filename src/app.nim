import tsGlue

let two* {.exportc.} = QTALKTOME
let twoString* {.exportc.} = QTALKTOME2

let three* {.exportc.} = QADDONE(QTALKTOME)

QCONSOLELOG("two plus one is " & $three)