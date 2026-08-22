#include <stdbool.h>
#include <stdio.h>
int main(void) {
  bool left = true, right = false;
  printf("%d:%d\n", left && !right, left || right);
  return 0;
}
