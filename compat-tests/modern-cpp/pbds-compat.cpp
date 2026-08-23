#include <bits/stdc++.h>
#include <ext/pb_ds/assoc_container.hpp>
#include <ext/pb_ds/tree_policy.hpp>

using namespace __gnu_pbds;

using ordered_set = tree<int, null_type, std::less<int>, rb_tree_tag,
                         tree_order_statistics_node_update>;

int main() {
  ordered_set values;
  values.insert(40);
  values.insert(10);
  values.insert(30);
  values.insert(20);
  std::cout << *values.find_by_order(2) << ' ' << values.order_of_key(30) << '\n';

  gp_hash_table<int, int> frequencies;
  frequencies[7] = 3;
  frequencies[7]++;
  std::cout << frequencies[7] << '\n';
  return 0;
}
