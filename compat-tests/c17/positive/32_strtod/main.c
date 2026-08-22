#include <stdio.h>
#include <stdlib.h>
int main(void) {
  char *end = NULL;
  double value = strtod("3.50x", &end);
  printf("%.1f:%c\n", value, *end);
  return 0;
}
