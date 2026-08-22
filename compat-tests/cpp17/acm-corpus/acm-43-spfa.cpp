#include <bits/stdc++.h>
using namespace std;

int main() {
  ios::sync_with_stdio(false);
  cin.tie(nullptr);
  int n, m;
  cin >> n >> m;
  vector<vector<pair<int, int>>> graph(n + 1);
  for (int i = 0; i < m; ++i) {
    int u, v, w;
    cin >> u >> v >> w;
    graph[u].push_back({v, w});
  }
  const int inf = numeric_limits<int>::max() / 4;
  vector<int> distance(n + 1, inf);
  vector<bool> queued(n + 1, false);
  queue<int> pending;
  distance[1] = 0;
  pending.push(1);
  queued[1] = true;
  while (!pending.empty()) {
    int u = pending.front();
    pending.pop();
    queued[u] = false;
    for (auto [v, w] : graph[u]) {
      if (distance[v] <= distance[u] + w) continue;
      distance[v] = distance[u] + w;
      if (!queued[v]) {
        pending.push(v);
        queued[v] = true;
      }
    }
  }
  for (int i = 1; i <= n; ++i) cout << distance[i] << (i == n ? '\n' : ' ');
}
