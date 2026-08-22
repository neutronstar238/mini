#include <stdio.h>
int main(void) {
  int values[3] = {2, 4, 6};
  int (*row)[3] = &values;
  printf("%d\n", (*row)[1] + values[2]);
  return 0;
}
