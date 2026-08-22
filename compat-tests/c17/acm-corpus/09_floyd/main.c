#include <stdio.h>
#define INF 1000000
int main(void) {
  int d[3][3] = {{0,3,10},{3,0,2},{10,2,0}};
  for (int k = 0; k < 3; ++k) for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j)
    if (d[i][k] + d[k][j] < d[i][j]) d[i][j] = d[i][k] + d[k][j];
  printf("%d\n", d[0][2]);
  return 0;
}
