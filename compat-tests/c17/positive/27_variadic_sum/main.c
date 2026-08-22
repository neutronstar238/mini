#include <stdarg.h>
#include <stdio.h>
static int sum_ints(size_t count, ...) {
  va_list args;
  va_start(args, count);
  int total = 0;
  for (size_t i = 0; i < count; ++i) total += va_arg(args, int);
  va_end(args);
  return total;
}
int main(void) {
  printf("%d\n", sum_ints(3, 10, 20, 12));
  return 0;
}
