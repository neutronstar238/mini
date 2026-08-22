#include <stdio.h>
int main(void) {
  int a[] = {5, 1, 4, 2, 3};
  int n = 5;
  for (int i = 0; i < n; ++i) for (int j = i + 1; j < n; ++j)
    if (a[j] < a[i]) { int t = a[i]; a[i] = a[j]; a[j] = t; }
  for (int i = 0; i < n; ++i) printf("%d%s", a[i], i + 1 == n ? "\n" : " ");
  return 0;
}
