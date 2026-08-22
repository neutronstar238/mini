#include <iostream>
#include <memory>
int main(){ auto p=std::make_shared<int>(9); std::cout<<*p<<"\n"; }
