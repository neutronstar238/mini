#include <functional>
#include <iostream>
int main(){ auto f=std::bind(std::multiplies<int>(),std::placeholders::_1,3); std::cout<<f(5)<<"\n"; }
