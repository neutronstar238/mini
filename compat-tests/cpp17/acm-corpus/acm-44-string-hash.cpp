#include <bits/stdc++.h>
using namespace std;

int main() {
  string text, pattern;
  cin >> text >> pattern;
  const uint64_t base = 131;
  vector<uint64_t> prefix(text.size() + 1), power(text.size() + 1, 1);
  for (size_t i = 0; i < text.size(); ++i) {
    prefix[i + 1] = prefix[i] * base + static_cast<unsigned char>(text[i]) + 1;
    power[i + 1] = power[i] * base;
  }
  uint64_t target = 0;
  for (unsigned char c : pattern) target = target * base + c + 1;
  bool first = true;
  for (size_t i = 0; i + pattern.size() <= text.size(); ++i) {
    uint64_t current = prefix[i + pattern.size()] - prefix[i] * power[pattern.size()];
    if (current != target || text.compare(i, pattern.size(), pattern) != 0) continue;
    if (!first) cout << ' ';
    cout << i;
    first = false;
  }
  cout << '\n';
}
