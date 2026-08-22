#include <stdio.h>
int main(void) {
  int value = 21;
  int *p = &value;
  int **pp = &p;
  **pp += 21;
  printf("%d\n", value);
  return 0;
}
