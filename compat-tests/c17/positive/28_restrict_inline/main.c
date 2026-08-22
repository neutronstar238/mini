#include <stdio.h>
static inline void add_one(int * restrict p) { *p += 1; }
int main(void) {
  int value = 41;
  add_one(&value);
  printf("%d\n", value);
  return 0;
}
