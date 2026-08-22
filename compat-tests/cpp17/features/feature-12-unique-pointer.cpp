#include <iostream>
#include <memory>
int main(){ std::unique_ptr<int> p(new int(11)); std::cout<<*p<<"\n"; }
