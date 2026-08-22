#include <stdio.h>
static int search(const int *a, int n, int key) {
  int lo = 0, hi = n - 1;
  while (lo <= hi) {
    int mid = lo + (hi - lo) / 2;
    if (a[mid] == key) return mid;
    if (a[mid] < key) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}
int main(void) {
  int a[] = {2, 4, 6, 8, 10};
  printf("%d:%d\n", search(a, 5, 8), search(a, 5, 7));
  return 0;
}
