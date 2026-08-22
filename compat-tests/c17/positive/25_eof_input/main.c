#include <stdio.h>
int main(void) {
  int value = 0, sum = 0;
  while (scanf("%d", &value) == 1) sum += value;
  printf("%d\n", sum);
  return 0;
}
