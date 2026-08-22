#include <math.h>
#include <stdio.h>
int main(void) {
  double x = -3.25;
  printf("%.0f %.0f %.0f %.0f\n", sqrt(16.0), floor(x), ceil(x), fabs(x));
  return 0;
}
