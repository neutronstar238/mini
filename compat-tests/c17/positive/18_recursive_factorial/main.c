#include <stdio.h>
static unsigned long factorial(unsigned n) {
  return n < 2 ? 1UL : (unsigned long)n * factorial(n - 1);
}
int main(void) {
  printf("%lu\n", factorial(6));
  return 0;
}
