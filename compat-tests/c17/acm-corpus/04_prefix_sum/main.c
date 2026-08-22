#include <stdio.h>
int main(void) {
  int a[] = {2, 1, 3, 4};
  int prefix[5] = {0};
  for (int i = 0; i < 4; ++i) prefix[i + 1] = prefix[i] + a[i];
  printf("%d:%d\n", prefix[2], prefix[4]);
  return 0;
}
