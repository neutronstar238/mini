#include <iostream>
constexpr int square(int x){return x*x;}
static_assert(square(5)==25);
int main(){ std::cout<<square(5)<<"\n"; }
