#ifndef MINI_OJ_MODERN_BITS_STDCXX_H
#define MINI_OJ_MODERN_BITS_STDCXX_H

/* GCC14-compatible aggregate for the supported libc++/WASI C++17 surface. */
#include <algorithm>
#include <any>
#include <array>
#include <cassert>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <exception>
#include <functional>
#include <iomanip>
#include <ios>
#include <iostream>
#include <iterator>
#include <list>
#include <map>
#include <memory>
#include <numeric>
#include <optional>
#include <queue>
#include <random>
#include <regex>
#include <set>
#include <sstream>
#include <stack>
#include <stdexcept>
#include <string>
#include <string_view>
#include <tuple>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <variant>
#include <vector>

#if defined(__wasi__)
#  ifndef _getchar_nolock
#    define _getchar_nolock getchar_unlocked
#  endif
#  ifndef _putchar_nolock
#    define _putchar_nolock putchar_unlocked
#  endif
#endif

namespace std {

/* GCC's common integer overloads; the precondition is x > 0. */
inline constexpr int __lg(int __n) {
  return sizeof(int) * 8 - 1 - __builtin_clz(static_cast<unsigned int>(__n));
}
inline constexpr unsigned __lg(unsigned __n) {
  return sizeof(unsigned) * 8 - 1 - __builtin_clz(__n);
}
inline constexpr long __lg(long __n) {
  return sizeof(long) * 8 - 1 - __builtin_clzl(static_cast<unsigned long>(__n));
}
inline constexpr unsigned long __lg(unsigned long __n) {
  return sizeof(unsigned long) * 8 - 1 - __builtin_clzl(__n);
}
inline constexpr long long __lg(long long __n) {
  return sizeof(long long) * 8 - 1 - __builtin_clzll(static_cast<unsigned long long>(__n));
}
inline constexpr unsigned long long __lg(unsigned long long __n) {
  return sizeof(unsigned long long) * 8 - 1 - __builtin_clzll(__n);
}

#if defined(_LIBCPP_VERSION) && _LIBCPP_STD_VER >= 17
/* Keep libc++'s unsigned internal template selected by std::gcd. */
inline constexpr long long __gcd(long long __m, long long __n) {
  return std::gcd(__m, __n);
}
#endif

} // namespace std

#endif
