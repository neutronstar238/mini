#include <stdio.h>
struct Point { int x; int y; };
int main(void) {
  struct Point p = {.y = 9, .x = 4};
  printf("%d\n", p.x + p.y);
  return 0;
}
