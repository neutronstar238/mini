#include <stdio.h>
int main(void) {
  static int values[4096];
  values[0] = 7;
  values[4095] = 9;
  printf("%d\n", values[0] + values[4095]);
  return 0;
}
