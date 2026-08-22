#include <iostream>
#include <type_traits>
template<class T> int kind(T v){ if constexpr(std::is_integral_v<T>) return v+1; else return 0; }
int main(){ std::cout<<kind(4)<<"\n"; }
