# Plain Tcl utility script: nothing to do with block designs.
proc fib {n} {
  if {$n < 2} { return $n }
  return [expr {[fib [expr {$n - 1}]] + [fib [expr {$n - 2}]]}]
}

set results {}
foreach i {1 2 3 4 5 6 7 8} {
  lappend results [fib $i]
}
puts "fib: $results"

namespace eval util {
  proc greet {name} { return "hello, $name" }
}
puts [util::greet world]
