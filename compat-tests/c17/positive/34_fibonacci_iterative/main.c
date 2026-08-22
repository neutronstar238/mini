#include <stdio.h>
static unsigned fib(unsigned n) {
  unsigned a = 0, b = 1;
  for (unsigned i = 0; i < n; ++i) {
    unsigned next = a + b; a = b; b = next;
  }
  return a;
}
int main(void) {
  printf("%u\n", fib(10));
  return 0;
}
