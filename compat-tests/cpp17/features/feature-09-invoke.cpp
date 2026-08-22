#include <functional>
#include <iostream>
int twice(int x){return x*2;}
int main(){ std::cout<<std::invoke(twice,6)<<"\n"; }
