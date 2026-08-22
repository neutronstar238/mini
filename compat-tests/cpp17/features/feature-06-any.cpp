#include <any>
#include <iostream>
int main(){ std::any x=7; std::cout<<std::any_cast<int>(x)<<"\n"; }
