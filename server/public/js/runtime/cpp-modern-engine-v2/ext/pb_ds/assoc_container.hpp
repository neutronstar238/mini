#ifndef MINI_OJ_PB_DS_ASSOC_CONTAINER_HPP
#define MINI_OJ_PB_DS_ASSOC_CONTAINER_HPP

/*
 * Small, project-owned GNU PBDS compatibility surface.
 *
 * The browser toolchain links libc++ rather than libstdc++, so the GNU-only
 * <ext/pb_ds/...> headers are not present in the WASI sysroot.  These types
 * intentionally cover the source-level PBDS API commonly used by contest
 * submissions while using the corresponding libc++ ordered/hash containers.
 * The order-statistics operations are logarithmic in neither direction here;
 * they are correctness shims, not a replacement for the server toolchain's
 * red-black tree implementation.
 */

#include <cstddef>
#include <functional>
#include <iterator>
#include <map>
#include <memory>
#include <set>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>

namespace __gnu_pbds {

struct null_type {};
struct rb_tree_tag {};
struct splay_tree_tag {};
struct ov_tree_tag {};

template <typename...> struct direct_mask_range_hashing {};
template <typename...> struct linear_probe_fn {};
template <typename...> struct quadratic_probe_fn {};
template <typename...> struct hash_standard_resize_policy {};
template <typename...> struct hash_load_check_resize_trigger {};

template <typename Node_CItr, typename Node_Itr, typename Cmp_Fn, typename Alloc>
struct null_node_update {};

template <typename Node_CItr, typename Node_Itr, typename Cmp_Fn, typename Alloc>
struct tree_order_statistics_node_update {};

template <typename Key,
          typename Mapped,
          typename Cmp_Fn = std::less<Key>,
          typename Tag = rb_tree_tag,
          template <typename, typename, typename, typename> class Node_Update = null_node_update,
          typename Allocator = std::allocator<char>>
class tree {
  static constexpr bool set_mode = std::is_same<Mapped, null_type>::value;
  using set_storage = std::set<Key, Cmp_Fn>;
  using map_storage = std::map<Key, Mapped, Cmp_Fn>;
  using storage_type = typename std::conditional<set_mode, set_storage, map_storage>::type;

  storage_type storage_;

public:
  using key_type = Key;
  using mapped_type = Mapped;
  using value_type = typename storage_type::value_type;
  using size_type = typename storage_type::size_type;
  using difference_type = typename storage_type::difference_type;
  using key_compare = Cmp_Fn;
  using iterator = typename storage_type::iterator;
  using const_iterator = typename storage_type::const_iterator;
  using reverse_iterator = typename storage_type::reverse_iterator;
  using const_reverse_iterator = typename storage_type::const_reverse_iterator;

  tree() = default;

  bool empty() const { return storage_.empty(); }
  size_type size() const { return storage_.size(); }
  size_type max_size() const { return storage_.max_size(); }
  void clear() { storage_.clear(); }

  iterator begin() { return storage_.begin(); }
  const_iterator begin() const { return storage_.begin(); }
  const_iterator cbegin() const { return storage_.cbegin(); }
  iterator end() { return storage_.end(); }
  const_iterator end() const { return storage_.end(); }
  const_iterator cend() const { return storage_.cend(); }
  reverse_iterator rbegin() { return storage_.rbegin(); }
  const_reverse_iterator rbegin() const { return storage_.rbegin(); }
  reverse_iterator rend() { return storage_.rend(); }
  const_reverse_iterator rend() const { return storage_.rend(); }

  std::pair<iterator, bool> insert(const value_type& value) { return storage_.insert(value); }

  template <typename Value>
  std::pair<iterator, bool> insert(Value&& value) {
    return storage_.insert(std::forward<Value>(value));
  }

  iterator find(const key_type& key) { return storage_.find(key); }
  const_iterator find(const key_type& key) const { return storage_.find(key); }
  size_type count(const key_type& key) const { return storage_.count(key); }
  iterator lower_bound(const key_type& key) { return storage_.lower_bound(key); }
  const_iterator lower_bound(const key_type& key) const { return storage_.lower_bound(key); }
  iterator upper_bound(const key_type& key) { return storage_.upper_bound(key); }
  const_iterator upper_bound(const key_type& key) const { return storage_.upper_bound(key); }

  iterator erase(const_iterator position) { return storage_.erase(position); }
  size_type erase(const key_type& key) { return storage_.erase(key); }

  template <typename M = Mapped>
  typename std::enable_if<!std::is_same<M, null_type>::value, M&>::type
  operator[](const key_type& key) {
    return storage_[key];
  }

  template <typename M = Mapped>
  typename std::enable_if<!std::is_same<M, null_type>::value, M&>::type
  at(const key_type& key) {
    return storage_.at(key);
  }

  template <typename M = Mapped>
  typename std::enable_if<!std::is_same<M, null_type>::value, const M&>::type
  at(const key_type& key) const {
    return storage_.at(key);
  }

  iterator find_by_order(size_type order) {
    if (order >= size()) return end();
    iterator result = begin();
    std::advance(result, static_cast<difference_type>(order));
    return result;
  }

  const_iterator find_by_order(size_type order) const {
    if (order >= size()) return end();
    const_iterator result = begin();
    std::advance(result, static_cast<difference_type>(order));
    return result;
  }

  size_type order_of_key(const key_type& key) const {
    return static_cast<size_type>(std::distance(cbegin(), lower_bound(key)));
  }

  key_compare key_comp() const { return storage_.key_comp(); }
  void swap(tree& other) { storage_.swap(other.storage_); }
};

template <typename Key,
          typename Mapped,
          typename Hash = std::hash<Key>,
          typename Eq = std::equal_to<Key>,
          typename... Options>
class gp_hash_table {
  static constexpr bool set_mode = std::is_same<Mapped, null_type>::value;
  using set_storage = std::unordered_set<Key, Hash, Eq>;
  using map_storage = std::unordered_map<Key, Mapped, Hash, Eq>;
  using storage_type = typename std::conditional<set_mode, set_storage, map_storage>::type;

  storage_type storage_;

public:
  using key_type = Key;
  using mapped_type = Mapped;
  using value_type = typename storage_type::value_type;
  using size_type = typename storage_type::size_type;
  using iterator = typename storage_type::iterator;
  using const_iterator = typename storage_type::const_iterator;

  bool empty() const { return storage_.empty(); }
  size_type size() const { return storage_.size(); }
  void clear() { storage_.clear(); }
  void reserve(size_type count) { storage_.reserve(count); }
  float load_factor() const { return storage_.load_factor(); }
  iterator begin() { return storage_.begin(); }
  const_iterator begin() const { return storage_.begin(); }
  iterator end() { return storage_.end(); }
  const_iterator end() const { return storage_.end(); }

  std::pair<iterator, bool> insert(const value_type& value) { return storage_.insert(value); }

  template <typename Value>
  std::pair<iterator, bool> insert(Value&& value) {
    return storage_.insert(std::forward<Value>(value));
  }

  iterator find(const key_type& key) { return storage_.find(key); }
  const_iterator find(const key_type& key) const { return storage_.find(key); }
  size_type count(const key_type& key) const { return storage_.count(key); }
  size_type erase(const key_type& key) { return storage_.erase(key); }

  template <typename M = Mapped>
  typename std::enable_if<!std::is_same<M, null_type>::value, M&>::type
  operator[](const key_type& key) {
    return storage_[key];
  }
};

template <typename Key,
          typename Mapped,
          typename Hash = std::hash<Key>,
          typename Eq = std::equal_to<Key>,
          typename... Options>
using cc_hash_table = gp_hash_table<Key, Mapped, Hash, Eq, Options...>;

}  // namespace __gnu_pbds

#endif
