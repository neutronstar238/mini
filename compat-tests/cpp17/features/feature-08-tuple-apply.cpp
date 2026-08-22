#include <iostream>
#include <tuple>
int main(){ auto t=std::make_tuple(2,3); std::cout<<std::apply([](auto a,auto b){return a*b;},t)<<"\n"; }
