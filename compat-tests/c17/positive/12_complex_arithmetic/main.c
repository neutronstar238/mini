#include <complex.h>
#include <stdio.h>
int main(void) {
  double complex z = 3.0 + 4.0 * I;
  double complex w = z * conj(z);
  printf("%.0f:%.0f\n", creal(w), cimag(w));
  return 0;
}
