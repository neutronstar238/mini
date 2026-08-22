#include <stdio.h>
int main(void) {
  int n = 4;
  int values[n];
  for (int i = 0; i < n; ++i) values[i] = i + 1;
  printf("%d\n", values[0] + values[n - 1]);
  return 0;
}
