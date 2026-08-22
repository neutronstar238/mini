#include <bits/stdc++.h>
using namespace std;

int main() {
  vector<int> values(200000);
  iota(values.begin(), values.end(), 0);
  long long sum = 0;
  for (int value : values) sum += value % 100;
  cout << sum << '\n';
}
